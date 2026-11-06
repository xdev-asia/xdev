//! Which browser tabs hold a live webview, and where a webview may be placed.

/// Most live webviews in one window; older ones are closed and keep their URL in the front end.
pub const MAX_LIVE: usize = 3;
/// Largest side a webview gets, in logical pixels.
const MAX_SIDE: f64 = 16384.0;

/// Live tabs, least recently shown first.
#[derive(Debug, Default)]
pub struct Pool {
    order: Vec<String>,
}

impl Pool {
    /// Marks `tab` as the most recently shown and returns the tabs that no longer fit.
    pub fn touch(&mut self, tab: &str) -> Vec<String> {
        self.order.retain(|t| t != tab);
        self.order.push(tab.to_owned());
        let over = self.order.len().saturating_sub(MAX_LIVE);
        self.order.drain(..over).collect()
    }

    /// Forgets `tab`; true when it was live.
    pub fn remove(&mut self, tab: &str) -> bool {
        let before = self.order.len();
        self.order.retain(|t| t != tab);
        self.order.len() != before
    }

    #[cfg(test)]
    pub fn live(&self) -> &[String] {
        &self.order
    }
}

/// A rectangle in logical pixels, relative to the window's content area.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "BrowserBounds"))]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whole pixels of a rectangle that can hold a webview, or None when there is nothing to show
/// (a value that is not finite, or an empty area).
pub fn clamp_bounds(b: Bounds) -> Option<Bounds> {
    if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()) {
        return None;
    }
    let width = b.width.round().clamp(0.0, MAX_SIDE);
    let height = b.height.round().clamp(0.0, MAX_SIDE);
    if width < 1.0 || height < 1.0 {
        return None;
    }
    Some(Bounds {
        x: b.x.round().clamp(-MAX_SIDE, MAX_SIDE),
        y: b.y.round().clamp(-MAX_SIDE, MAX_SIDE),
        width,
        height,
    })
}

/// The webview label of a tab: `browser-` and the id with anything but letters, digits, `-` and
/// `_` turned into `_`. No capability names a webview with this prefix, so the page gets no
/// app or plugin command.
pub fn label_of(tab: &str) -> String {
    let id: String = tab
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("browser-{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_three_live_and_evicts_the_oldest() {
        let mut p = Pool::default();
        assert!(p.touch("a").is_empty());
        assert!(p.touch("b").is_empty());
        assert!(p.touch("c").is_empty());
        // Showing `a` again makes `b` the oldest.
        assert!(p.touch("a").is_empty());
        assert_eq!(p.touch("d"), vec!["b".to_owned()]);
        assert_eq!(p.live(), ["c", "a", "d"]);
        assert!(p.remove("a"));
        assert!(!p.remove("a"));
        assert!(p.touch("e").is_empty());
        assert_eq!(p.touch("f"), vec!["c".to_owned()]);
        assert_eq!(p.live(), ["d", "e", "f"]);
    }

    #[test]
    fn clamps_bounds() {
        let b = |x, y, width, height| Bounds {
            x,
            y,
            width,
            height,
        };
        let cases = [
            (
                b(10.4, 20.6, 300.5, 200.2),
                Some(b(10.0, 21.0, 301.0, 200.0)),
            ),
            (b(0.0, 0.0, 0.0, 100.0), None),
            (b(0.0, 0.0, 100.0, 0.4), None),
            (b(0.0, 0.0, -5.0, 100.0), None),
            (b(f64::NAN, 0.0, 100.0, 100.0), None),
            (b(0.0, 0.0, f64::INFINITY, 100.0), None),
            (b(-20.0, 5.0, 1e9, 50.0), Some(b(-20.0, 5.0, 16384.0, 50.0))),
        ];
        for (input, want) in cases {
            assert_eq!(clamp_bounds(input), want, "{input:?}");
        }
    }

    #[test]
    fn labels_have_the_browser_prefix() {
        assert_eq!(label_of("browser:3"), "browser-browser_3");
        assert_eq!(label_of("a b/c"), "browser-a_b_c");
        assert_eq!(label_of(&"x".repeat(100)).len(), "browser-".len() + 64);
    }
}
