import type { ComponentType } from 'react';

import { ArtPrintDetailsForm } from '@/components/item-detail/art-print-details-form';
import { BookDetailsForm } from '@/components/item-detail/book-details-form';
import { CustomOtherDetailsForm } from '@/components/item-detail/custom-other-details-form';
import { PinDetailsForm } from '@/components/item-detail/pin-details-form';
import { SneakerDetailsForm } from '@/components/item-detail/sneaker-details-form';
import { ToyDetailsForm } from '@/components/item-detail/toy-details-form';
import { WatchDetailsForm } from '@/components/item-detail/watch-details-form';
import { artPrintAdapter } from '@/lib/other-item-art-prints';
import { bookAdapter } from '@/lib/other-item-books';
import { customOtherAdapter } from '@/lib/other-item-custom';
import { pinAdapter } from '@/lib/other-item-pins';
import { sneakerAdapter } from '@/lib/other-item-sneakers';
import { toyAdapter } from '@/lib/other-item-toys';
import { watchAdapter } from '@/lib/other-item-watches';
import type { OtherCategoryAdapter } from '@/lib/other-items';
import type { OtherItemCategory } from '@/types';

// Every Other category's form + adapter, keyed by category. Item Detail's
// edit mode looks a saved item's category up here, so one generic code path
// handles all of them. Each entry pairs a form with the adapter for the
// same form state; the pairing is checked here, then erased to `unknown`
// so callers can hold any category's form state in one place.

type FormProps<F> = { value: F; onChange: (next: F) => void };

export type OtherCategoryEntry = {
  adapter: OtherCategoryAdapter<unknown>;
  Form: ComponentType<FormProps<unknown>>;
};

function entry<F>(adapter: OtherCategoryAdapter<F>, Form: ComponentType<FormProps<F>>): OtherCategoryEntry {
  return { adapter, Form } as unknown as OtherCategoryEntry;
}

export const OTHER_CATEGORY_ENTRIES: Record<OtherItemCategory, OtherCategoryEntry> = {
  sneakers: entry(sneakerAdapter, SneakerDetailsForm),
  watches: entry(watchAdapter, WatchDetailsForm),
  art_prints: entry(artPrintAdapter, ArtPrintDetailsForm),
  toys: entry(toyAdapter, ToyDetailsForm),
  books: entry(bookAdapter, BookDetailsForm),
  pins: entry(pinAdapter, PinDetailsForm),
  custom: entry(customOtherAdapter, CustomOtherDetailsForm),
};
