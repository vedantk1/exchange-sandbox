import { Layers3 } from 'lucide-react';

export const PRODUCT_NAME = 'Spot Exchange Simulator';

export function Brand() {
  return (
    <>
      <span className="brand-mark" aria-hidden="true">
        <Layers3 size={22} />
      </span>
      <span className="brand-name">
        Spot Exchange<span className="brand-sub">Simulator</span>
      </span>
    </>
  );
}
