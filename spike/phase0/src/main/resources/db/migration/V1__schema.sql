CREATE TABLE accounts (
    id        bigserial PRIMARY KEY,
    owner     text    NOT NULL,
    balance   bigint  NOT NULL CHECK (balance >= 0),
    meta      jsonb   NOT NULL DEFAULT '{}'::jsonb,
    tags      text[]  NOT NULL DEFAULT '{}'
);
CREATE TABLE ledger (
    id         bigserial PRIMARY KEY,
    from_id    bigint NOT NULL REFERENCES accounts(id),
    to_id      bigint NOT NULL REFERENCES accounts(id),
    amount     bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
    id         bigserial PRIMARY KEY,
    payload    text NOT NULL,
    claimed_by text,
    claimed_at timestamptz
);
CREATE INDEX jobs_unclaimed ON jobs (id) WHERE claimed_by IS NULL;
