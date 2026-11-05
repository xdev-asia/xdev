//! Which account a provider's new agent starts on.

use serde::{Deserialize, Serialize};

pub type AccountId = String;

/// How a provider's new agents pick their account.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    /// The default account.
    #[default]
    Manual,
    /// The account with the most room in its tightest window.
    MostQuota,
    /// The next account after the one used last.
    RoundRobin,
    /// The first account of a user-ordered list.
    Priority,
}

/// One routing decision's inputs besides the pool.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Route<'a> {
    pub policy: Policy,
    /// The provider's default account; `None` is the CLI's own home.
    pub default: Option<&'a str>,
    /// The `Priority` order; accounts it leaves out follow in pool order.
    pub priority: &'a [AccountId],
    /// Percent at which an account counts as over its limit. `None` is 100,
    /// and keeps `Manual` on the default whatever its usage.
    pub limit: Option<f64>,
}

/// An account's usage in its tightest window; `None` when unknown.
#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub id: AccountId,
    pub used: Option<f64>,
}

/// The account a new agent starts on.
///
/// `pool` is the accounts routing may pick, in the user's order. An account
/// with no usage data is never over its limit, and ranks after every known
/// one for `MostQuota`. When every account is over its limit, the least used
/// one wins. Ties go to the default, then to pool order. An empty pool, and
/// `Manual` while the default is under its limit, give the default; `None`
/// only when there is no default either.
pub fn pick_account(
    policy: &Route,
    pool: &[AccountId],
    quotas: &[Usage],
    last_used: Option<&str>,
) -> Option<AccountId> {
    let default = policy.default.map(str::to_owned);
    if pool.is_empty() {
        return default;
    }
    let limit = policy.limit.unwrap_or(100.0);
    let used = |id: &str| quotas.iter().find(|u| u.id == id).and_then(|u| u.used);
    let over = |id: &str| used(id).is_some_and(|u| u >= limit);
    // Manual leaves the default only when auto-switch is on and it is over.
    if policy.policy == Policy::Manual
        && !(policy.limit.is_some() && policy.default.is_some_and(over))
    {
        return default;
    }
    let eligible: Vec<&AccountId> = pool.iter().filter(|id| !over(id)).collect();
    if eligible.is_empty() {
        return least_used(pool, policy.default, &used);
    }
    let first =
        |mut order: Box<dyn Iterator<Item = &AccountId> + '_>| order.find(|id| !over(id)).cloned();
    match policy.policy {
        Policy::Manual | Policy::MostQuota => least_used(&eligible, policy.default, &used),
        Policy::RoundRobin => {
            let start = last_used
                .and_then(|last| pool.iter().position(|id| id == last))
                .map_or(0, |at| at + 1);
            first(Box::new(pool.iter().cycle().skip(start).take(pool.len())))
        }
        Policy::Priority => {
            let listed = policy.priority.iter().filter(|id| pool.contains(id));
            let rest = pool.iter().filter(|id| !policy.priority.contains(id));
            first(Box::new(listed.chain(rest)))
        }
    }
}

/// The lowest known usage, unknowns after; ties to `default`, then order.
fn least_used<S: AsRef<str>>(
    order: &[S],
    default: Option<&str>,
    used: &dyn Fn(&str) -> Option<f64>,
) -> Option<AccountId> {
    order
        .iter()
        .map(AsRef::as_ref)
        .enumerate()
        .min_by(|(i, a), (j, b)| {
            let rank = |id: &str| used(id).unwrap_or(f64::INFINITY);
            rank(a)
                .total_cmp(&rank(b))
                .then_with(|| (Some(*b) == default).cmp(&(Some(*a) == default)))
                .then_with(|| i.cmp(j))
        })
        .map(|(_, id)| id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<AccountId> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    fn usage(pairs: &[(&str, Option<f64>)]) -> Vec<Usage> {
        pairs
            .iter()
            .map(|(id, used)| Usage {
                id: (*id).to_owned(),
                used: *used,
            })
            .collect()
    }

    fn route(policy: Policy, default: Option<&str>) -> Route<'_> {
        Route {
            policy,
            default,
            priority: &[],
            limit: None,
        }
    }

    fn pick(
        r: &Route,
        pool: &[&str],
        quotas: &[(&str, Option<f64>)],
        last: Option<&str>,
    ) -> Option<String> {
        pick_account(r, &ids(pool), &usage(quotas), last)
    }

    #[test]
    fn manual_keeps_the_default_whatever_the_quota() {
        let r = route(Policy::Manual, Some("a"));
        assert_eq!(
            pick(
                &r,
                &["a", "b"],
                &[("a", Some(99.0)), ("b", Some(1.0))],
                None
            )
            .as_deref(),
            Some("a")
        );
    }

    #[test]
    fn manual_with_auto_switch_leaves_a_default_over_the_limit() {
        let r = Route {
            limit: Some(80.0),
            ..route(Policy::Manual, Some("a"))
        };
        let quotas = [("a", Some(85.0)), ("b", Some(40.0)), ("c", Some(10.0))];
        assert_eq!(
            pick(&r, &["a", "b", "c"], &quotas, None).as_deref(),
            Some("c")
        );
        let under = [("a", Some(79.0)), ("b", Some(10.0))];
        assert_eq!(pick(&r, &["a", "b"], &under, None).as_deref(), Some("a"));
    }

    #[test]
    fn most_quota_takes_the_least_used() {
        let r = route(Policy::MostQuota, Some("a"));
        let quotas = [("a", Some(50.0)), ("b", Some(20.0)), ("c", Some(30.0))];
        assert_eq!(
            pick(&r, &["a", "b", "c"], &quotas, None).as_deref(),
            Some("b")
        );
    }

    #[test]
    fn a_tie_goes_to_the_default_then_to_pool_order() {
        let quotas = [("a", Some(20.0)), ("b", Some(20.0)), ("c", Some(20.0))];
        let with_default = route(Policy::MostQuota, Some("c"));
        assert_eq!(
            pick(&with_default, &["a", "b", "c"], &quotas, None).as_deref(),
            Some("c")
        );
        let without = route(Policy::MostQuota, None);
        assert_eq!(
            pick(&without, &["b", "a", "c"], &quotas, None).as_deref(),
            Some("b")
        );
    }

    #[test]
    fn missing_quota_data_ranks_after_known_and_is_never_over() {
        let r = route(Policy::MostQuota, None);
        let quotas = [("a", None), ("b", Some(90.0))];
        assert_eq!(pick(&r, &["a", "b"], &quotas, None).as_deref(), Some("b"));
        // No entry at all is the same as unknown.
        assert_eq!(pick(&r, &["a", "b"], &[], None).as_deref(), Some("a"));
        let limited = Route {
            limit: Some(80.0),
            ..r
        };
        assert_eq!(
            pick(&limited, &["a", "b"], &quotas, None).as_deref(),
            Some("a")
        );
        let rr = Route {
            limit: Some(80.0),
            ..route(Policy::RoundRobin, None)
        };
        assert_eq!(
            pick(&rr, &["a", "b"], &[("a", None), ("b", None)], Some("a")).as_deref(),
            Some("b")
        );
    }

    #[test]
    fn an_empty_pool_gives_the_default() {
        for policy in [
            Policy::Manual,
            Policy::MostQuota,
            Policy::RoundRobin,
            Policy::Priority,
        ] {
            let r = Route {
                limit: Some(80.0),
                ..route(policy, Some("a"))
            };
            assert_eq!(
                pick(&r, &[], &[("a", Some(99.0))], Some("a")).as_deref(),
                Some("a")
            );
            assert_eq!(pick(&route(policy, None), &[], &[], None), None);
        }
    }

    #[test]
    fn every_account_over_its_limit_gives_the_least_used() {
        let quotas = [("a", Some(97.0)), ("b", Some(96.0)), ("c", Some(99.0))];
        for policy in [
            Policy::Manual,
            Policy::MostQuota,
            Policy::RoundRobin,
            Policy::Priority,
        ] {
            let r = Route {
                limit: Some(95.0),
                ..route(policy, Some("a"))
            };
            assert_eq!(
                pick(&r, &["a", "b", "c"], &quotas, Some("b")).as_deref(),
                Some("b"),
                "{policy:?}"
            );
        }
        // Equal usage over the limit stays on the default.
        let full = [("a", Some(100.0)), ("b", Some(100.0))];
        let r = route(Policy::MostQuota, Some("b"));
        assert_eq!(pick(&r, &["a", "b"], &full, None).as_deref(), Some("b"));
    }

    #[test]
    fn round_robin_cycles_after_the_last_used() {
        let r = route(Policy::RoundRobin, Some("a"));
        let pool = ["a", "b", "c"];
        assert_eq!(pick(&r, &pool, &[], None).as_deref(), Some("a"));
        assert_eq!(pick(&r, &pool, &[], Some("a")).as_deref(), Some("b"));
        assert_eq!(pick(&r, &pool, &[], Some("c")).as_deref(), Some("a"));
        // One left out of the pool since: start over.
        assert_eq!(pick(&r, &pool, &[], Some("gone")).as_deref(), Some("a"));
    }

    #[test]
    fn round_robin_skips_an_account_over_its_limit() {
        let r = route(Policy::RoundRobin, None);
        let quotas = [("b", Some(100.0))];
        assert_eq!(
            pick(&r, &["a", "b", "c"], &quotas, Some("a")).as_deref(),
            Some("c")
        );
    }

    #[test]
    fn priority_takes_the_first_listed_under_its_limit() {
        let order = ids(&["c", "x", "a"]);
        let r = Route {
            priority: &order,
            ..route(Policy::Priority, Some("b"))
        };
        assert_eq!(pick(&r, &["a", "b", "c"], &[], None).as_deref(), Some("c"));
        let quotas = [("c", Some(100.0)), ("a", Some(100.0))];
        // Unlisted pool accounts follow the list.
        assert_eq!(
            pick(&r, &["a", "b", "c"], &quotas, None).as_deref(),
            Some("b")
        );
    }
}
