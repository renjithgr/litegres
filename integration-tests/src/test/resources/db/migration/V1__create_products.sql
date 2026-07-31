create table products (
    id bigint generated always as identity primary key,
    sku text not null unique,
    price_cents int not null
);

insert into products (sku, price_cents) values ('WIDGET-1', 1999);
