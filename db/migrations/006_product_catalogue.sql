CREATE TABLE supplier (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (btrim(name) <> '')
);

CREATE TABLE product_category (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (btrim(name) <> '')
);

CREATE TABLE product (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id uuid NOT NULL REFERENCES supplier (id),
    category_id uuid NOT NULL REFERENCES product_category (id),
    supplier_sku text CHECK (btrim(supplier_sku) <> ''),
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text NOT NULL CHECK (btrim(description) <> ''),
    unit_code text NOT NULL CHECK (btrim(unit_code) <> ''),
    UNIQUE (supplier_id, supplier_sku)
);

CREATE INDEX product_by_category ON product (category_id, name);

CREATE TABLE product_price (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES product (id),
    valid_from date NOT NULL CHECK (isfinite(valid_from)),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    unit_price numeric NOT NULL CHECK (unit_price >= 0 AND unit_price < 'Infinity'::numeric),
    UNIQUE (product_id, currency, valid_from)
);

ALTER TABLE material_item ADD COLUMN product_id uuid REFERENCES product (id);
CREATE INDEX material_item_by_product ON material_item (product_id) WHERE product_id IS NOT NULL;

CREATE TRIGGER a_product_supplier BEFORE UPDATE ON product
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'supplier_id', 'unit_code');

CREATE TRIGGER a_price_product BEFORE UPDATE ON product_price
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'product_id');

CREATE FUNCTION require_product_price() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
    catalogue_product_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'product' THEN
        catalogue_product_id := NEW.id;
        PERFORM 1 FROM product WHERE id = catalogue_product_id;
    ELSE
        catalogue_product_id := OLD.product_id;
        -- A row write serializes concurrent attempts to remove prices for the same product.
        UPDATE product SET id = id WHERE id = catalogue_product_id;
    END IF;
    IF FOUND AND NOT EXISTS (SELECT FROM product_price WHERE product_id = catalogue_product_id) THEN
        RAISE EXCEPTION 'A catalogue product must have at least one dated price'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER product_requires_price AFTER INSERT ON product
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_product_price();

CREATE CONSTRAINT TRIGGER product_retains_price AFTER DELETE ON product_price
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_product_price();
