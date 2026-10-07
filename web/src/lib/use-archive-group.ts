import { toast } from 'sonner';
import { errorMessage } from './api';
import { useArchiveGroup } from './queries';
import type { Group } from './types';

/**
 * Archive / unarchive a group for myself, with a toast that offers Undo (the
 * opposite toggle). The change is optimistic, so the toast shows right away.
 */
export function useArchiveToggle() {
  const archive = useArchiveGroup();
  const toggle = (group: Pick<Group, 'id' | 'name'>, archived: boolean, offerUndo = true) => {
    archive.mutate(
      { groupId: group.id, archived },
      { onError: (err) => toast.error(errorMessage(err), { id: `archive-${group.id}` }) },
    );
    toast.success(archived ? `Archived ${group.name}` : `${group.name} is back on Home`, {
      id: `archive-${group.id}`,
      description: archived ? 'Hidden from your Home — only for you.' : undefined,
      action: offerUndo
        ? { label: 'Undo', onClick: () => toggle(group, !archived, false) }
        : undefined,
    });
  };
  return toggle;
}
