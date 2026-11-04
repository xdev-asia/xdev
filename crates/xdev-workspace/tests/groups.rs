mod common;

use std::fs;
use std::path::Path;

use common::{commit_all, init, long_temp_dir};
use xdev_workspace::{
    Registry, SidebarItem, WorkspaceError, add_repo, archive_worktree, create_worktree, folder_add,
    folder_forget, forget_repo, group_move, group_put, group_remove, set_order, sidebar,
};

/// The ids of top-level items, groups written as `g:<id>[members]`.
fn shape(items: &[SidebarItem]) -> Vec<String> {
    items
        .iter()
        .map(|i| match i {
            SidebarItem::Repo { repo, .. } => repo.short_name.clone(),
            SidebarItem::Folder { folder } => format!("f:{}", folder.name),
            SidebarItem::Group { group, items } => {
                format!("g:{}{:?}", group.name, shape(items))
            }
        })
        .collect()
}

/// Three repos `a`, `b`, `c` in one temp dir, added in that order, plus a
/// plain folder `plain` beside them.
fn three() -> (Registry, [String; 3], tempfile::TempDir) {
    let tmp = long_temp_dir("ws groups ");
    let mut reg = Registry::default();
    let mut ids = Vec::new();
    for name in ["a", "b", "c"] {
        let dest = tmp.path().join(name);
        fs::create_dir(&dest).unwrap();
        init(&dest);
        commit_all(&dest, "one");
        ids.push(add_repo(&mut reg, &dest, 0).unwrap().id);
    }
    fs::create_dir(tmp.path().join("plain")).unwrap();
    (reg, ids.try_into().unwrap(), tmp)
}

#[test]
fn sidebar_follows_order_then_add_order() {
    let (mut reg, [a, _b, c], _tmp) = three();
    assert_eq!(shape(&sidebar(&mut reg, 0).unwrap()), ["a", "b", "c"]);
    set_order(&mut reg, &[c.clone(), "nope".to_owned(), a.clone()]).unwrap();
    assert_eq!(shape(&sidebar(&mut reg, 0).unwrap()), ["c", "a", "b"]);
}

#[test]
fn group_holds_repos_and_folders() {
    let (mut reg, [a, _b, _c], tmp) = three();
    let f = folder_add(&mut reg, &tmp.path().join("plain")).unwrap();
    assert_eq!(f.name, "plain");
    let g = group_put(&mut reg, None, "Work").unwrap();
    group_move(&mut reg, &f.id, Some(&g), 0).unwrap();
    group_move(&mut reg, &a, Some(&g), 0).unwrap();
    assert_eq!(
        shape(&sidebar(&mut reg, 0).unwrap()),
        ["b", "c", "g:Work[\"a\", \"f:plain\"]"]
    );
    // Out again, to the top at index 0.
    group_move(&mut reg, &a, None, 0).unwrap();
    assert_eq!(
        shape(&sidebar(&mut reg, 0).unwrap()),
        ["a", "b", "c", "g:Work[\"f:plain\"]"]
    );
    // Rename keeps the id.
    assert_eq!(group_put(&mut reg, Some(&g), "Home").unwrap(), g);
    assert_eq!(reg.groups[0].name, "Home");
}

#[test]
fn removing_group_moves_members_to_top() {
    let (mut reg, [a, b, c], _tmp) = three();
    let g = group_put(&mut reg, None, "G").unwrap();
    group_move(&mut reg, &b, Some(&g), 0).unwrap();
    set_order(&mut reg, &[c.clone(), g.clone(), a.clone()]).unwrap();
    assert_eq!(
        shape(&sidebar(&mut reg, 0).unwrap()),
        ["c", "g:G[\"b\"]", "a"]
    );
    group_remove(&mut reg, &g).unwrap();
    assert_eq!(shape(&sidebar(&mut reg, 0).unwrap()), ["c", "b", "a"]);
    assert!(reg.groups.is_empty());
}

#[test]
fn folder_add_refuses_repos_and_worktrees() {
    let (mut reg, [a, _b, _c], tmp) = three();
    let err = folder_add(&mut reg, &tmp.path().join("a")).unwrap_err();
    assert_eq!(err.code(), "folder_exists");
    let wt = create_worktree(&mut reg, &a, "w", None, 1, 1).unwrap();
    let err = folder_add(&mut reg, Path::new(&wt.path)).unwrap_err();
    assert!(matches!(err, WorkspaceError::FolderExists(_)), "{err:?}");
    let err = folder_add(&mut reg, &tmp.path().join("missing")).unwrap_err();
    assert_eq!(err.code(), "not_found");
    folder_add(&mut reg, &tmp.path().join("plain")).unwrap();
    let err = folder_add(&mut reg, &tmp.path().join("plain")).unwrap_err();
    assert_eq!(err.code(), "folder_exists");
}

#[test]
fn forget_folder_touches_nothing_on_disk() {
    let (mut reg, _ids, tmp) = three();
    let plain = tmp.path().join("plain");
    fs::write(plain.join("note.txt"), "keep me").unwrap();
    let f = folder_add(&mut reg, &plain).unwrap();
    let g = group_put(&mut reg, None, "G").unwrap();
    group_move(&mut reg, &f.id, Some(&g), 0).unwrap();
    folder_forget(&mut reg, &f.id).unwrap();
    assert_eq!(
        fs::read_to_string(plain.join("note.txt")).unwrap(),
        "keep me"
    );
    assert!(reg.folders.is_empty());
    assert!(reg.groups[0].members.is_empty());
    assert!(!reg.order.contains(&f.id));
}

#[test]
fn unknown_ids_error() {
    let (mut reg, [a, _b, _c], _tmp) = three();
    assert_eq!(
        group_remove(&mut reg, "x").unwrap_err().code(),
        "group_unknown"
    );
    assert_eq!(
        folder_forget(&mut reg, "x").unwrap_err().code(),
        "folder_unknown"
    );
    assert_eq!(
        group_move(&mut reg, &a, Some("x"), 0).unwrap_err().code(),
        "group_unknown"
    );
    assert_eq!(
        group_put(&mut reg, Some("x"), "n").unwrap_err().code(),
        "group_unknown"
    );
    assert_eq!(
        group_put(&mut reg, None, "  ").unwrap_err().code(),
        "bad_name"
    );
    assert_eq!(
        group_move(&mut reg, "x", None, 0).unwrap_err().code(),
        "repo_unknown"
    );
}

#[test]
fn sidebar_carries_kept_branches_per_repo() {
    let (mut reg, [a, _b, _c], _tmp) = three();
    let wt = create_worktree(&mut reg, &a, "w", None, 1, 1).unwrap();
    archive_worktree(&mut reg, Path::new(&wt.path), false, 5).unwrap();
    let items = sidebar(&mut reg, 10).unwrap();
    let SidebarItem::Repo { repo, kept } = &items[0] else {
        panic!("{items:?}")
    };
    assert_eq!(repo.id, a);
    assert_eq!(kept.len(), 1);
    assert!(kept[0].archived_shown);
}

#[test]
fn forgetting_a_repo_drops_it_from_groups_and_order() {
    let (mut reg, [a, b, _c], _tmp) = three();
    let g = group_put(&mut reg, None, "G").unwrap();
    group_move(&mut reg, &a, Some(&g), 0).unwrap();
    set_order(&mut reg, std::slice::from_ref(&b)).unwrap();
    forget_repo(&mut reg, &a).unwrap();
    forget_repo(&mut reg, &b).unwrap();
    assert!(reg.groups[0].members.is_empty());
    assert!(!reg.order.contains(&b));
}
