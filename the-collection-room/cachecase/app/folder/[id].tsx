import { Redirect, useLocalSearchParams } from 'expo-router';

// Legacy folder-detail route — superseded by app/collection/[folderId].tsx,
// which now owns folder loading, ownership/privacy checks, edit/delete,
// share, and bookmarking (migrated from this screen). Kept only as a
// compatibility redirect so old in-app params, deep links, and shared
// `thecollectionroom://folder/:id` links still resolve.
export default function LegacyFolderRedirect() {
  const { id, name } = useLocalSearchParams<{ id?: string; name?: string }>();

  if (!id) {
    return <Redirect href="/collection" />;
  }

  return (
    <Redirect
      href={{
        pathname: '/collection/[folderId]',
        params: { folderId: id, title: name ?? '' },
      }}
    />
  );
}
