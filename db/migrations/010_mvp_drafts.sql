-- Editable BOM drafts: optimistic-locking revision, draft currency and draft unit rates.
-- IF NOT EXISTS: early development databases applied this change under version 9.
ALTER TABLE bom_version
    ADD COLUMN IF NOT EXISTS edit_revision integer NOT NULL DEFAULT 0 CHECK (edit_revision >= 0),
    ADD COLUMN IF NOT EXISTS draft_currency char(3) CHECK (draft_currency ~ '^[A-Z]{3}$');

ALTER TABLE bom_line
    ADD COLUMN IF NOT EXISTS draft_unit_price numeric CHECK (
        draft_unit_price > '-Infinity'::numeric AND draft_unit_price < 'Infinity'::numeric
    );
