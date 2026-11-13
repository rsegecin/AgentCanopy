import type { Attachment } from '../../../shared';
import { Icon, IconButton } from '../../app/components';
import { formatBytes } from './paste-image';

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

export function describeAttachment(attachment: Attachment): {
  icon: string;
  text: string;
  title: string;
} {
  switch (attachment.kind) {
    case 'file':
      return { icon: 'file', text: basename(attachment.path), title: attachment.path };
    case 'folder':
      return { icon: 'folder', text: basename(attachment.path), title: attachment.path };
    case 'selection': {
      const range =
        attachment.startLine === attachment.endLine
          ? String(attachment.startLine)
          : `${String(attachment.startLine)}-${String(attachment.endLine)}`;
      return {
        icon: 'selection',
        text: `${basename(attachment.path)}:${range}`,
        title: `Selection in ${attachment.path}, lines ${range}`,
      };
    }
    case 'diagnostics':
      return {
        icon: 'warning',
        text: `Problems in ${basename(attachment.path)}`,
        title: `Diagnostics for ${attachment.path}`,
      };
    case 'image': {
      const subtype = attachment.mediaType.slice('image/'.length).toUpperCase();
      const text = `Image ${attachment.id.slice(0, 6)} · ${subtype} · ${formatBytes(attachment.bytes)}`;
      return { icon: 'file-media', text, title: text };
    }
  }
}

/** A chip for a context attachment. Pass `onRemove` for the removable form used in the composer. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: () => void;
}) {
  const { icon, text, title } = describeAttachment(attachment);
  return (
    <li className="chip" title={title}>
      <Icon name={icon} />
      <span className="chip-text">{text}</span>
      {onRemove && <IconButton icon="close" label={`Remove ${text}`} onClick={onRemove} />}
    </li>
  );
}
