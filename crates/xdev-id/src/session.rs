//! The sign-in state machine. Pure: no network, no clock, no OS; the caller passes the
//! store, random bytes and `Instant`s, and runs HTTP outside the lock.
//!
//! One attempt at a time (newest wins). A callback consumes the attempt before any HTTP,
//! and a `generation` counter drops results whose attempt was cancelled or replaced.

use std::time::Instant;

use serde::Serialize;

use crate::callback::{Callback, parse_callback, same_state};
use crate::http::{CallError, Me, TokenReply};
use crate::link::{authorize_url, clean_device};
use crate::pkce::{PkcePair, Secret, b64url};
use crate::store::{Stored, StoredUser, TokenStore};
use crate::{ATTEMPT_TTL, E_CODE, E_EXPIRED, E_KEYCHAIN, E_STATE, E_TIMEOUT, E_UNAVAILABLE};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct XdevIdUser {
    pub name: String,
    pub email: String,
    /// A `data:` URL.
    pub avatar: Option<String>,
}

/// What the frontend sees. It never holds the token.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum XdevIdState {
    /// `notice` is one of the `E_*` codes, or null.
    SignedOut {
        notice: Option<String>,
    },
    /// `link` is the authorize URL, for "Open again" and "Copy link".
    SigningIn {
        link: String,
    },
    SignedIn {
        user: XdevIdUser,
    },
}

struct Attempt {
    state: String,
    verifier: Secret,
    started: Instant,
    generation: u64,
}

pub struct Session {
    state: XdevIdState,
    attempt: Option<Attempt>,
    token: Option<Secret>,
    user: Option<StoredUser>,
    avatar: Option<String>,
    generation: u64,
    base: String,
}

/// What the glue opens in the browser.
pub struct Begin {
    pub link: String,
}

/// The one-time code and verifier to trade for a token.
pub struct Redeem {
    pub generation: u64,
    pub code: Secret,
    pub verifier: Secret,
}

fn signed_out(notice: Option<&str>) -> XdevIdState {
    XdevIdState::SignedOut {
        notice: notice.map(str::to_owned),
    }
}

impl Session {
    pub fn new(base: String) -> Session {
        Session {
            state: signed_out(None),
            attempt: None,
            token: None,
            user: None,
            avatar: None,
            generation: 0,
            base,
        }
    }

    pub fn state(&self) -> XdevIdState {
        self.state.clone()
    }

    /// The state when no attempt is running: signed in if we hold a token and a profile.
    fn resting(&self, notice: Option<&str>) -> XdevIdState {
        match (&self.token, &self.user) {
            (Some(_), Some(user)) => XdevIdState::SignedIn {
                user: XdevIdUser {
                    name: user.name.clone(),
                    email: user.email.clone(),
                    avatar: self.avatar.clone(),
                },
            },
            _ => signed_out(notice),
        }
    }

    /// A background change (refresh, avatar) never hides a running attempt.
    /// Returns whether the visible state changed.
    fn refresh_view(&mut self, notice: Option<&str>) -> bool {
        if matches!(self.state, XdevIdState::SigningIn { .. }) {
            return false;
        }
        let next = self.resting(notice);
        let changed = next != self.state;
        self.state = next;
        changed
    }

    /// Loads the keychain into memory. A failing store leaves the state signed out.
    pub fn load(&mut self, store: &dyn TokenStore) -> Result<(), &'static str> {
        match store.load() {
            Err(_) => {
                self.state = signed_out(None);
                Err(E_KEYCHAIN)
            }
            Ok(None) => {
                self.state = signed_out(None);
                Ok(())
            }
            Ok(Some(stored)) => {
                self.token = Some(stored.token);
                self.user = stored.user;
                self.avatar = None;
                self.state = self.resting(None);
                Ok(())
            }
        }
    }

    /// A new attempt; replaces any pending one. `bytes` is (verifier, state) from the OS
    /// random source in production and fixed in tests. The store is probed first so a
    /// machine without a keychain fails before the browser opens.
    pub fn begin(
        &mut self,
        store: &dyn TokenStore,
        bytes: ([u8; 32], [u8; 32]),
        device: &str,
        now: Instant,
    ) -> Result<Begin, &'static str> {
        store.load().map_err(|_| E_KEYCHAIN)?;
        let pair = PkcePair::from_bytes(bytes.0);
        let state = b64url(&bytes.1);
        let link = authorize_url(&self.base, &pair.challenge, &state, &clean_device(device));
        self.generation += 1;
        self.attempt = Some(Attempt {
            state,
            verifier: pair.verifier,
            started: now,
            generation: self.generation,
        });
        self.state = XdevIdState::SigningIn { link: link.clone() };
        Ok(Begin { link })
    }

    pub fn cancel(&mut self) {
        self.generation += 1;
        self.attempt = None;
        self.state = self.resting(None);
    }

    /// A deep link or a paste. A wrong state keeps the attempt; a matching one consumes it.
    pub fn accept(&mut self, raw: &str, now: Instant) -> Result<Option<Redeem>, &'static str> {
        let callback = parse_callback(raw)?;
        let state = match &callback {
            Callback::Code { state, .. } | Callback::Denied { state } => state.expose(),
        };
        let Some(attempt) = &self.attempt else {
            return Err(E_STATE);
        };
        if !same_state(state, &attempt.state) {
            return Err(E_STATE);
        }
        let expired = now.saturating_duration_since(attempt.started) > ATTEMPT_TTL;
        let Some(attempt) = self.attempt.take() else {
            return Err(E_STATE);
        };
        if expired {
            self.state = self.resting(Some(E_TIMEOUT));
            return Err(E_TIMEOUT);
        }
        match callback {
            Callback::Denied { .. } => {
                self.state = self.resting(None);
                Ok(None)
            }
            Callback::Code { code, .. } => Ok(Some(Redeem {
                generation: attempt.generation,
                code,
                verifier: attempt.verifier,
            })),
        }
    }

    /// Applies an exchange result. `Ok(false)` means the attempt was cancelled or replaced
    /// meanwhile: nothing changed and the caller signs the new token out.
    pub fn finish(
        &mut self,
        store: &dyn TokenStore,
        generation: u64,
        result: Result<(TokenReply, Me), CallError>,
    ) -> Result<bool, &'static str> {
        if generation != self.generation {
            return Ok(false);
        }
        self.generation += 1;
        match result {
            Ok((reply, me)) => {
                let user = StoredUser {
                    name: me.name,
                    email: me.email,
                    image: me.image,
                };
                let stored = Stored {
                    token: reply.token,
                    user: Some(user),
                };
                if store.save(&stored).is_err() {
                    self.state = self.resting(Some(E_KEYCHAIN));
                    return Err(E_KEYCHAIN);
                }
                self.token = Some(stored.token);
                self.user = stored.user;
                self.avatar = None;
                self.state = self.resting(None);
            }
            Err(CallError::InvalidCode) => self.state = self.resting(Some(E_CODE)),
            Err(CallError::Unavailable | CallError::Unauthorized) => {
                self.state = self.resting(Some(E_UNAVAILABLE));
            }
        }
        Ok(true)
    }

    /// Ends a pending attempt older than `ATTEMPT_TTL`. Returns whether the state changed.
    pub fn expire(&mut self, now: Instant) -> bool {
        let expired = self
            .attempt
            .as_ref()
            .is_some_and(|a| now.saturating_duration_since(a.started) > ATTEMPT_TTL);
        if !expired {
            return false;
        }
        self.attempt = None;
        self.generation += 1;
        self.state = self.resting(Some(E_TIMEOUT));
        true
    }

    /// The token for a `/me` refresh, when we hold one.
    pub fn token(&self) -> Option<Secret> {
        self.token.clone()
    }

    /// Applies a `/me` result. Only a 401 signs out; anything else keeps the state.
    pub fn refreshed(
        &mut self,
        store: &dyn TokenStore,
        token_used: &Secret,
        result: Result<Me, CallError>,
    ) -> bool {
        if self.token.as_ref() != Some(token_used) {
            return false;
        }
        match result {
            Ok(me) => {
                let user = StoredUser {
                    name: me.name,
                    email: me.email,
                    image: me.image,
                };
                if self.user.as_ref() == Some(&user) {
                    return false;
                }
                if self.user.as_ref().map(|u| &u.image) != Some(&user.image) {
                    self.avatar = None;
                }
                let stored = Stored {
                    token: token_used.clone(),
                    user: Some(user.clone()),
                };
                // A failed write only loses the offline copy of the profile.
                let _ = store.save(&stored);
                self.user = Some(user);
                self.refresh_view(None)
            }
            Err(CallError::Unauthorized) => {
                // Best effort: the token is dead either way.
                let _ = store.clear();
                self.token = None;
                self.user = None;
                self.avatar = None;
                self.refresh_view(Some(E_EXPIRED))
            }
            Err(CallError::InvalidCode | CallError::Unavailable) => false,
        }
    }

    /// The avatar as a `data:` URL. Returns whether the visible state changed.
    pub fn set_avatar(&mut self, data_url: Option<String>) -> bool {
        if self.user.is_none() || self.avatar == data_url {
            return false;
        }
        self.avatar = data_url;
        self.refresh_view(None)
    }

    /// Takes the token out for `/signout` and clears the store. The state is signed out
    /// even when the keychain delete fails.
    pub fn sign_out(
        &mut self,
        store: &dyn TokenStore,
    ) -> (Option<Secret>, Result<(), &'static str>) {
        let token = self.token.take();
        self.user = None;
        self.avatar = None;
        self.attempt = None;
        self.generation += 1;
        self.state = signed_out(None);
        let cleared = store.clear().map(|_| ()).map_err(|_| E_KEYCHAIN);
        (token, cleared)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::store::MemoryStore;

    const BASE: &str = "https://id.test";

    fn vbytes() -> [u8; 32] {
        [1; 32]
    }

    fn sbytes() -> [u8; 32] {
        [2; 32]
    }

    fn state_text() -> String {
        b64url(&sbytes())
    }

    fn cb(state: &str) -> String {
        format!(
            "xdev://auth/callback?code={}&state={state}",
            b64url(&[3; 32])
        )
    }

    fn reply(token: &str) -> TokenReply {
        TokenReply {
            token: Secret::new(token.into()),
            expires_at: "2027-01-01T00:00:00Z".into(),
        }
    }

    fn me(name: &str) -> Me {
        Me {
            name: name.into(),
            email: "d@x.test".into(),
            image: None,
        }
    }

    const TOKEN: &str = "tok_tok_tok_tok_tok_tok_tok";

    fn started() -> (Session, MemoryStore, Instant) {
        let mut s = Session::new(BASE.into());
        let store = MemoryStore::default();
        let now = Instant::now();
        s.begin(&store, (vbytes(), sbytes()), "Duy PC", now)
            .unwrap();
        (s, store, now)
    }

    fn signed_in() -> (Session, MemoryStore) {
        let (mut s, store, now) = started();
        let r = s.accept(&cb(&state_text()), now).unwrap().unwrap();
        assert!(
            s.finish(&store, r.generation, Ok((reply(TOKEN), me("Duy"))))
                .unwrap()
        );
        (s, store)
    }

    #[test]
    fn load_reads_the_store() {
        let store = MemoryStore::default();
        let mut s = Session::new(BASE.into());
        s.load(&store).unwrap();
        assert_eq!(s.state(), signed_out(None));

        store
            .save(&Stored {
                token: Secret::new(TOKEN.into()),
                user: Some(StoredUser {
                    name: "Duy".into(),
                    email: "d@x.test".into(),
                    image: None,
                }),
            })
            .unwrap();
        s.load(&store).unwrap();
        assert_eq!(
            s.state(),
            XdevIdState::SignedIn {
                user: XdevIdUser {
                    name: "Duy".into(),
                    email: "d@x.test".into(),
                    avatar: None
                }
            }
        );

        store.set_fail(true);
        let mut s = Session::new(BASE.into());
        assert_eq!(s.load(&store), Err(E_KEYCHAIN));
        assert_eq!(s.state(), signed_out(None));
    }

    #[test]
    fn begin_builds_the_link_and_probes_the_store() {
        let (s, _, _) = started();
        let XdevIdState::SigningIn { link } = s.state() else {
            panic!("not signing in");
        };
        let url = url::Url::parse(&link).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/desktop");
        assert_eq!(q["challenge"], crate::pkce::s256(&b64url(&vbytes())));
        assert_eq!(q["state"], state_text());
        assert_eq!(q["device"], "Duy PC");

        let store = MemoryStore::default();
        store.set_fail(true);
        let mut s = Session::new(BASE.into());
        assert_eq!(
            s.begin(&store, (vbytes(), sbytes()), "d", Instant::now())
                .err(),
            Some(E_KEYCHAIN)
        );
        assert_eq!(s.state(), signed_out(None));
    }

    #[test]
    fn newest_attempt_wins() {
        let (mut s, store, now) = started();
        let second = ([4; 32], [5; 32]);
        s.begin(&store, second, "d", now).unwrap();
        assert_eq!(s.accept(&cb(&state_text()), now).err(), Some(E_STATE));
        assert!(s.accept(&cb(&b64url(&second.1)), now).unwrap().is_some());
    }

    #[test]
    fn accept_checks_state_once_and_time() {
        let (mut s, _, now) = started();
        let wrong = b64url(&[9; 32]);
        assert_eq!(s.accept(&cb(&wrong), now).err(), Some(E_STATE));
        assert!(matches!(s.state(), XdevIdState::SigningIn { .. }));
        assert_eq!(s.accept("junk", now).err(), Some(crate::E_LINK));
        let good = cb(&state_text());
        assert!(s.accept(&good, now).unwrap().is_some());
        assert_eq!(s.accept(&good, now).err(), Some(E_STATE));

        let mut none = Session::new(BASE.into());
        assert_eq!(none.accept(&good, now).err(), Some(E_STATE));

        let (mut s, _, now) = started();
        let late = now + ATTEMPT_TTL + Duration::from_secs(1);
        assert_eq!(s.accept(&good, late).err(), Some(E_TIMEOUT));
        assert_eq!(s.accept(&good, now).err(), Some(E_STATE));
        assert_eq!(s.state(), signed_out(Some(E_TIMEOUT)),);

        let (mut s, _, now) = started();
        let denied = format!(
            "xdev://auth/callback?error=access_denied&state={}",
            state_text()
        );
        assert!(s.accept(&denied, now).unwrap().is_none());
        assert_eq!(s.state(), signed_out(None));
    }

    #[test]
    fn finish_ok_stores_the_token_and_hides_it_from_the_state() {
        let (s, store) = signed_in();
        let XdevIdState::SignedIn { user } = s.state() else {
            panic!("not signed in");
        };
        assert_eq!(user.name, "Duy");
        let saved = store.load().unwrap().unwrap();
        assert_eq!(saved.token.expose(), TOKEN);
        assert_eq!(saved.user.unwrap().email, "d@x.test");
        assert!(!serde_json::to_string(&s.state()).unwrap().contains(TOKEN));
        assert_eq!(s.token().unwrap().expose(), TOKEN);
    }

    #[test]
    fn finish_failures_set_a_notice_and_write_nothing() {
        for (err, notice) in [
            (CallError::InvalidCode, E_CODE),
            (CallError::Unavailable, E_UNAVAILABLE),
        ] {
            let (mut s, store, now) = started();
            let r = s.accept(&cb(&state_text()), now).unwrap().unwrap();
            assert!(s.finish(&store, r.generation, Err(err)).unwrap());
            assert_eq!(s.state(), signed_out(Some(notice)));
            assert!(store.raw().is_none());
        }
        let (mut s, store, now) = started();
        let r = s.accept(&cb(&state_text()), now).unwrap().unwrap();
        store.set_fail(true);
        assert_eq!(
            s.finish(&store, r.generation, Ok((reply(TOKEN), me("Duy"))))
                .err(),
            Some(E_KEYCHAIN)
        );
        assert_eq!(s.state(), signed_out(Some(E_KEYCHAIN)));
        assert!(s.token().is_none());
    }

    #[test]
    fn stale_generation_changes_nothing() {
        let (mut s, store, now) = started();
        let r = s.accept(&cb(&state_text()), now).unwrap().unwrap();
        s.cancel();
        assert!(
            !s.finish(&store, r.generation, Ok((reply(TOKEN), me("Duy"))))
                .unwrap()
        );
        assert_eq!(s.state(), signed_out(None));
        assert!(store.raw().is_none());

        let (mut s, store, now) = started();
        let r = s.accept(&cb(&state_text()), now).unwrap().unwrap();
        s.begin(&store, ([4; 32], [5; 32]), "d", now).unwrap();
        let before = s.state();
        assert!(
            !s.finish(&store, r.generation, Ok((reply(TOKEN), me("Duy"))))
                .unwrap()
        );
        assert_eq!(s.state(), before);
        assert!(store.raw().is_none());
    }

    #[test]
    fn refreshed_applies_only_a_401_or_a_new_profile() {
        let (mut s, store) = signed_in();
        let token = s.token().unwrap();
        assert!(!s.refreshed(&store, &token, Err(CallError::Unavailable)));
        assert!(matches!(s.state(), XdevIdState::SignedIn { .. }));
        assert!(!s.refreshed(&store, &token, Ok(me("Duy"))));

        assert!(s.refreshed(&store, &token, Ok(me("Duy Tran"))));
        assert!(matches!(&s.state(), XdevIdState::SignedIn { user } if user.name == "Duy Tran"));
        assert_eq!(
            store.load().unwrap().unwrap().user.unwrap().name,
            "Duy Tran"
        );

        let other = Secret::new("another_token_another_tok".into());
        assert!(!s.refreshed(&store, &other, Err(CallError::Unauthorized)));
        assert!(matches!(s.state(), XdevIdState::SignedIn { .. }));

        assert!(s.refreshed(&store, &token, Err(CallError::Unauthorized)));
        assert_eq!(s.state(), signed_out(Some(E_EXPIRED)));
        assert!(store.raw().is_none());
        assert!(s.token().is_none());
    }

    #[test]
    fn a_refresh_does_not_hide_a_running_attempt() {
        let (mut s, store) = signed_in();
        let token = s.token().unwrap();
        s.begin(&store, (vbytes(), sbytes()), "d", Instant::now())
            .unwrap();
        assert!(!s.refreshed(&store, &token, Err(CallError::Unauthorized)));
        assert!(matches!(s.state(), XdevIdState::SigningIn { .. }));
        s.cancel();
        assert_eq!(s.state(), signed_out(None));
    }

    #[test]
    fn avatar_updates_the_signed_in_state() {
        let (mut s, _) = signed_in();
        assert!(s.set_avatar(Some("data:image/png;base64,AA".into())));
        assert!(!s.set_avatar(Some("data:image/png;base64,AA".into())));
        assert!(matches!(&s.state(),
            XdevIdState::SignedIn { user } if user.avatar.as_deref() == Some("data:image/png;base64,AA")));
        let mut out = Session::new(BASE.into());
        assert!(!out.set_avatar(Some("x".into())));
    }

    #[test]
    fn sign_out_returns_the_token_even_when_the_keychain_fails() {
        let (mut s, store) = signed_in();
        let (token, result) = s.sign_out(&store);
        assert_eq!(token.unwrap().expose(), TOKEN);
        assert!(result.is_ok());
        assert_eq!(s.state(), signed_out(None));
        assert!(store.raw().is_none());

        let (mut s, store) = signed_in();
        store.set_fail(true);
        let (token, result) = s.sign_out(&store);
        assert!(token.is_some());
        assert_eq!(result, Err(E_KEYCHAIN));
        assert_eq!(s.state(), signed_out(None));
    }

    #[test]
    fn expire_ends_an_old_attempt() {
        let (mut s, _, now) = started();
        assert!(!s.expire(now + ATTEMPT_TTL));
        assert!(s.expire(now + ATTEMPT_TTL + Duration::from_secs(1)));
        assert_eq!(s.state(), signed_out(Some(E_TIMEOUT)));
        assert!(!s.expire(now + ATTEMPT_TTL * 3));
    }

    #[test]
    fn every_state_serialises_without_a_secret() {
        let (s, _) = signed_in();
        let json = serde_json::to_string(&s.state()).unwrap();
        assert!(json.contains(r#""state":"signedIn""#));
        let json = serde_json::to_string(&signed_out(Some(E_EXPIRED))).unwrap();
        assert_eq!(json, r#"{"state":"signedOut","notice":"account_expired"}"#);
    }
}
