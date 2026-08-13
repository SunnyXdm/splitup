import {
  Car,
  Film,
  HeartPulse,
  House,
  Plane,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  Utensils,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Category } from './types';

export const CATEGORY_META: Record<Category, { label: string; icon: LucideIcon }> = {
  general: { label: 'General', icon: Receipt },
  food: { label: 'Food & drink', icon: Utensils },
  groceries: { label: 'Groceries', icon: ShoppingCart },
  transport: { label: 'Transport', icon: Car },
  home: { label: 'Home', icon: House },
  utilities: { label: 'Utilities', icon: Zap },
  travel: { label: 'Travel', icon: Plane },
  shopping: { label: 'Shopping', icon: ShoppingBag },
  entertainment: { label: 'Entertainment', icon: Film },
  health: { label: 'Health', icon: HeartPulse },
};

export const CATEGORIES = Object.keys(CATEGORY_META) as Category[];
