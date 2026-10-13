import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className="dialog-content"
          aria-describedby={description ? descriptionId : undefined}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <div className="dialog-heading">
            <Primitive.Title>{title}</Primitive.Title>
            <Primitive.Close className="icon-button" aria-label="Close dialog">
              <X size={18} />
            </Primitive.Close>
          </div>
          {description && (
            <Primitive.Description id={descriptionId} className="muted dialog-description">
              {description}
            </Primitive.Description>
          )}
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function LoadingView({ message = 'Loading the exchange…' }: { message?: string }) {
  return (
    <div className="loading-view" role="status">
      <span className="spinner" />
      {message}
    </div>
  );
}
