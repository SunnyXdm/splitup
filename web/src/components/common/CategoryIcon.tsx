import { CATEGORY_META } from '@/lib/categories';
import type { Category } from '@/lib/types';

export function CategoryIcon({ category, className }: { category: Category; className?: string }) {
  const Icon = (CATEGORY_META[category] ?? CATEGORY_META.general).icon;
  return <Icon className={className} aria-hidden="true" />;
}
