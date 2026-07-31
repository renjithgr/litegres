create table accounts (
    id bigint primary key,
    name text not null
);

insert into accounts (id, name) values (1, 'Ada Lovelace');
