ALTER TABLE product_price
    ADD COLUMN price_basis text NOT NULL DEFAULT 'supplier_quote',
    ADD COLUMN source_document_id uuid REFERENCES source_document (id),
    ADD COLUMN source_locator jsonb,
    ADD CONSTRAINT product_price_known_basis
        CHECK (price_basis IN ('supplier_quote', 'tender_offer')),
    ADD CONSTRAINT product_price_source
        CHECK (
            (source_locator IS NULL OR (
                source_document_id IS NOT NULL AND jsonb_typeof(source_locator) = 'object'
            ))
            AND (price_basis <> 'tender_offer' OR (
                source_document_id IS NOT NULL AND source_locator IS NOT NULL
            ))
        ),
    DROP CONSTRAINT product_price_product_id_currency_valid_from_key,
    ADD CONSTRAINT product_price_dated_basis_key
        UNIQUE (product_id, currency, price_basis, valid_from);
