use super::*;

fn tab(id: &str, status: NotchTabStatus) -> NotchTab {
    NotchTab {
        pty_id: id.into(),
        status,
        name: format!("agent {id}"),
        worktree: "/work/app".into(),
    }
}

#[test]
fn waiting_for_input_comes_before_everything() {
    let tabs = [
        tab("a", NotchTabStatus::Working),
        tab("b", NotchTabStatus::Failed),
        tab("c", NotchTabStatus::NeedsYou),
        tab("d", NotchTabStatus::NeedsYou),
    ];
    assert_eq!(
        pick(&tabs),
        NotchView::NeedsYou {
            pty_id: "c".into(),
            name: "agent c".into(),
            worktree: "/work/app".into(),
            others: 1,
        }
    );
}

#[test]
fn an_error_comes_before_work() {
    let tabs = [
        tab("a", NotchTabStatus::Working),
        tab("b", NotchTabStatus::Failed),
        tab("c", NotchTabStatus::Done),
    ];
    assert_eq!(
        pick(&tabs),
        NotchView::Failed {
            pty_id: "b".into(),
            name: "agent b".into(),
            worktree: "/work/app".into(),
            others: 0,
        }
    );
}

#[test]
fn working_agents_are_counted() {
    let tabs = [
        tab("a", NotchTabStatus::Idle),
        tab("b", NotchTabStatus::Working),
        tab("c", NotchTabStatus::Working),
    ];
    assert_eq!(
        pick(&tabs),
        NotchView::Working {
            pty_id: "b".into(),
            count: 2,
        }
    );
}

#[test]
fn idle_done_and_exited_hide_the_strip() {
    let tabs = [
        tab("a", NotchTabStatus::Idle),
        tab("b", NotchTabStatus::Done),
        tab("c", NotchTabStatus::Exited),
    ];
    assert_eq!(pick(&tabs), NotchView::Hidden);
    assert_eq!(pick(&[]), NotchView::Hidden);
}

#[test]
fn the_view_serializes_with_a_kind() {
    let view = NotchView::Working {
        pty_id: "p".into(),
        count: 3,
    };
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        serde_json::json!({ "kind": "working", "ptyId": "p", "count": 3 })
    );
    assert_eq!(
        serde_json::to_value(NotchView::Hidden).unwrap(),
        serde_json::json!({ "kind": "hidden" })
    );
    let tab: NotchTab = serde_json::from_value(serde_json::json!({
        "ptyId": "p", "status": "needs-you", "name": "n", "worktree": "/w"
    }))
    .unwrap();
    assert_eq!(tab.status, NotchTabStatus::NeedsYou);
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

/// A 14-inch built-in display: 1512x982 points, a 37 point notch 185 wide.
fn notched() -> Screen {
    Screen {
        frame: rect(0.0, 0.0, 1512.0, 982.0),
        visible: rect(0.0, 0.0, 1512.0, 945.0),
        top_inset: 37.0,
        left: Some(rect(0.0, 945.0, 663.5, 37.0)),
        right: Some(rect(848.5, 945.0, 663.5, 37.0)),
    }
}

#[test]
fn wraps_the_notch_with_a_wing_each_side() {
    let p = place(&notched());
    assert_eq!(p.gap, 185.0);
    assert_eq!(p.frame, rect(663.5 - WING, 945.0, 185.0 + 2.0 * WING, 37.0));
}

#[test]
fn without_a_notch_sits_at_the_top_centre() {
    let screen = Screen {
        frame: rect(0.0, 0.0, 1440.0, 900.0),
        visible: rect(0.0, 0.0, 1440.0, 875.0),
        top_inset: 0.0,
        left: None,
        right: None,
    };
    let p = place(&screen);
    assert_eq!(p.gap, 0.0);
    assert_eq!(
        p.frame,
        rect(580.0, 875.0 - PILL_H - PILL_GAP, PILL_W, PILL_H)
    );
}

#[test]
fn empty_side_areas_count_as_no_notch() {
    let mut screen = notched();
    screen.top_inset = 0.0;
    screen.left = Some(rect(0.0, 0.0, 0.0, 0.0));
    screen.right = Some(rect(0.0, 0.0, 0.0, 0.0));
    let p = place(&screen);
    assert_eq!(p.gap, 0.0);
    assert_eq!(p.frame.w, PILL_W);
}

#[test]
fn an_external_main_display_uses_its_own_frame() {
    // A 2560 wide display as the main one, with the built-in one beside it;
    // the origin is that display's, and its menu bar leaves 2560x1415.
    let screen = Screen {
        frame: rect(-2560.0, 120.0, 2560.0, 1440.0),
        visible: rect(-2560.0, 120.0, 2560.0, 1415.0),
        top_inset: 0.0,
        left: Some(rect(0.0, 0.0, 0.0, 0.0)),
        right: Some(rect(0.0, 0.0, 0.0, 0.0)),
    };
    let p = place(&screen);
    assert_eq!(p.gap, 0.0);
    assert_eq!(p.frame.x, -2560.0 + (2560.0 - PILL_W) / 2.0);
    assert_eq!(p.frame.y, 120.0 + 1415.0 - PILL_H - PILL_GAP);
}

#[test]
fn stays_inside_a_narrow_display() {
    let screen = Screen {
        frame: rect(0.0, 0.0, 200.0, 600.0),
        visible: rect(0.0, 0.0, 200.0, 575.0),
        top_inset: 0.0,
        left: None,
        right: None,
    };
    assert_eq!(place(&screen).frame.x, 0.0);
}

#[test]
fn the_state_changes_only_when_the_pick_does() {
    let notch = Notch::default();
    let working = pick(&[tab("a", NotchTabStatus::Working)]);
    assert!(notch.update(|s| s.view = working.clone()));
    assert!(!notch.update(|s| s.view = working));
    assert!(notch.update(|s| s.gap = 185.0));
}
