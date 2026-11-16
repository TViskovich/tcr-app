// Which folders' cached covers an item change makes stale (P2.3 Issue 4).
// Pure, so it is unit tested: node --test lib/folder-cover-invalidation.test.ts
//
// A folder's 'first_card' cover resolves to its newest active item's primary
// photo, and an 'item' cover to the chosen item's primary photo — neither is
// reflected on the folders row. So every change below can change the cover:
//   photos  — a photo added, removed, reordered or made primary (its folder)
//   created — a new item (its folder: it is now the newest)
//   deleted — an item deleted (its folder)
//   moved   — an item moved (the source AND the destination folder)
//   bulkMoved — several items moved at once (every source folder AND the
//             destination; review F4). Nested folders: a cover resolves only
//             from a folder's OWN items, so moving between a folder and one of
//             its galleries changes exactly those two covers.
// A manually uploaded cover is unaffected in content: invalidating it only
// re-signs the same image.
export type ItemCoverChange =
  | { kind: 'photos' | 'created' | 'deleted'; folderId: string | null | undefined }
  | { kind: 'moved'; fromFolderId: string | null | undefined; toFolderId: string | null | undefined }
  | { kind: 'bulkMoved'; fromFolderIds: (string | null | undefined)[]; toFolderId: string | null | undefined };

export function foldersAffectedBy(change: ItemCoverChange): string[] {
  const ids =
    change.kind === 'moved'
      ? [change.fromFolderId, change.toFolderId]
      : change.kind === 'bulkMoved'
        ? [...change.fromFolderIds, change.toFolderId]
        : [change.folderId];
  return uniqueFolderIds(ids);
}

export function uniqueFolderIds(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}
