ALTER TABLE material_group
    ADD COLUMN parent_id uuid,
    ADD UNIQUE (project_id, id),
    ADD FOREIGN KEY (project_id, parent_id) REFERENCES material_group (project_id, id),
    ADD CHECK (parent_id <> id);

ALTER TABLE activity_group
    ADD COLUMN parent_id uuid,
    ADD UNIQUE (project_id, id),
    ADD FOREIGN KEY (project_id, parent_id) REFERENCES activity_group (project_id, id),
    ADD CHECK (parent_id <> id);

CREATE INDEX material_group_by_parent ON material_group (project_id, parent_id);
CREATE INDEX activity_group_by_parent ON activity_group (project_id, parent_id);

CREATE FUNCTION check_group_hierarchy_cycle() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
    is_cycle boolean;
BEGIN
    -- Lock every ancestor, including the root, to guard against concurrent moves.
    EXECUTE format(
        'WITH RECURSIVE ancestors(id) AS (
            SELECT $1
            UNION
            SELECT node.parent_id
            FROM ancestors
            CROSS JOIN LATERAL (
                SELECT parent_id FROM %I.%I WHERE id = ancestors.id FOR SHARE
            ) node
        )
        SELECT EXISTS (SELECT FROM ancestors WHERE id = $2)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) INTO is_cycle USING NEW.parent_id, NEW.id;

    IF is_cycle THEN
        RAISE EXCEPTION '% hierarchy cannot contain a cycle', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hierarchy_cycle AFTER INSERT OR UPDATE OF parent_id ON material_group
FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
EXECUTE FUNCTION check_group_hierarchy_cycle();

CREATE TRIGGER hierarchy_cycle AFTER INSERT OR UPDATE OF parent_id ON activity_group
FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
EXECUTE FUNCTION check_group_hierarchy_cycle();
