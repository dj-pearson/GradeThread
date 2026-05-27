-- Add three new photo classification values to the existing enum.
-- detail_2 / detail_3: additional close-up slots (up to 3 labeled detail shots).
-- interior: lining / inside-view shot useful for jackets, coats, bags.
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'detail_2' AFTER 'detail';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'detail_3' AFTER 'detail_2';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'interior' AFTER 'detail_3';
