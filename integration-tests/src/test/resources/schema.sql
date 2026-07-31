create table accounts (
    id bigint generated always as identity primary key,
    name text not null,
    balance_cents bigint not null default 0
);
