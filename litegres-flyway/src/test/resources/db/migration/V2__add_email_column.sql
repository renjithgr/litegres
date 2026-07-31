alter table accounts add column email text;

update accounts set email = 'ada@example.com' where id = 1;
