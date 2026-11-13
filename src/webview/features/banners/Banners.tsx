import { useRef } from 'react';
import type { Banner } from '../../../shared';
import { Icon, IconButton, VisuallyHidden } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';

const LEVEL: Record<Banner['level'], { icon: string; label: string }> = {
  info: { icon: 'info', label: 'Information' },
  warning: { icon: 'warning', label: 'Warning' },
  error: { icon: 'error', label: 'Error' },
};

export function Banners() {
  const post = usePost();
  const banners = useViewState((s) => s.banners);
  const root = useRef<HTMLDivElement>(null);
  // Dismissing a banner removes the button that had focus: go back to the composer.
  useFocusRecovery(root, {
    fallback: () => document.querySelector<HTMLElement>('textarea[aria-label="Message"]'),
  });
  if (banners.length === 0) return null;
  return (
    <div ref={root} className="banners">
      {banners.map((banner) => {
        const level = LEVEL[banner.level];
        return (
          <div
            key={banner.id}
            className={`banner banner--${banner.level}`}
            role={banner.level === 'error' ? 'alert' : 'status'}
          >
            <Icon name={level.icon} />
            <p className="banner-text">
              <VisuallyHidden>{level.label}: </VisuallyHidden>
              {banner.text}
            </p>
            {banner.action && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  if (banner.action) {
                    post({
                      type: 'banner.action',
                      bannerId: banner.id,
                      actionId: banner.action.id,
                    });
                  }
                }}
              >
                {banner.action.label}
              </button>
            )}
            {banner.dismissible && (
              <IconButton
                icon="close"
                label="Dismiss"
                onClick={() => {
                  post({ type: 'banner.dismiss', bannerId: banner.id });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
