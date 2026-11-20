ALTER TABLE product
    ALTER COLUMN supplier_id DROP NOT NULL,
    ALTER COLUMN unit_code DROP NOT NULL,
    ADD COLUMN review_status text NOT NULL DEFAULT 'approved',
    ADD CONSTRAINT product_review_status CHECK (
        review_status = 'pending'
        OR (review_status = 'approved' AND supplier_id IS NOT NULL AND unit_code IS NOT NULL)
    );

CREATE FUNCTION protect_approved_product() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.id <> OLD.id OR (OLD.review_status = 'approved' AND (
        NEW.review_status <> OLD.review_status
        OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
        OR NEW.unit_code IS DISTINCT FROM OLD.unit_code
    )) THEN
        RAISE EXCEPTION 'Approved product identity, supplier and purchase unit are fixed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER a_product_supplier ON product;
CREATE TRIGGER a_product_identity BEFORE UPDATE ON product
FOR EACH ROW EXECUTE FUNCTION protect_approved_product();

CREATE OR REPLACE FUNCTION require_product_price() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
    catalogue_product_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'product' THEN
        catalogue_product_id := NEW.id;
    ELSE
        catalogue_product_id := OLD.product_id;
        -- Serialize concurrent attempts to remove rates for one product.
        UPDATE product SET id = id WHERE id = catalogue_product_id;
    END IF;
    IF EXISTS (SELECT FROM product WHERE id = catalogue_product_id AND review_status = 'approved')
       AND NOT EXISTS (SELECT FROM product_price WHERE product_id = catalogue_product_id) THEN
        RAISE EXCEPTION 'An approved catalogue product must have at least one dated price'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER product_approval_requires_price AFTER UPDATE OF review_status ON product
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_product_price();

CREATE TABLE catalogue_source_line (
    source_document_id uuid NOT NULL REFERENCES source_document (id),
    source_kind text NOT NULL CHECK (source_kind IN ('item', 'item_candidate', 'price')),
    source_locator jsonb NOT NULL CHECK (jsonb_typeof(source_locator) = 'object'),
    source_line_code text,
    position_key text NOT NULL CHECK (btrim(position_key) <> ''),
    decision text NOT NULL CHECK (decision IN ('supply', 'installed', 'activity', 'review', 'heading')),
    product_id uuid REFERENCES product (id),
    tender_unit text,
    rate_amount numeric CHECK (rate_amount > '-Infinity'::numeric AND rate_amount < 'Infinity'::numeric),
    rate_currency char(3) CHECK (rate_currency ~ '^[A-Z]{3}$'),
    PRIMARY KEY (source_document_id, source_kind, source_locator),
    CHECK ((product_id IS NOT NULL) = (decision IN ('supply', 'installed')))
);

CREATE INDEX catalogue_source_line_by_position ON catalogue_source_line (position_key);
CREATE INDEX catalogue_source_line_by_product ON catalogue_source_line (product_id)
WHERE product_id IS NOT NULL;
