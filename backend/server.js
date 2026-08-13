async function setup(){

if(!DATABASE_URL){
console.log(
"DATABASE_URL is not configured."
);
return;
}

await db(`
CREATE TABLE IF NOT EXISTS wallets(
user_id TEXT PRIMARY KEY,
balance NUMERIC(14,2)
NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ
NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ
NOT NULL DEFAULT NOW()
)
`);

await db(`
CREATE TABLE IF NOT EXISTS transactions(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
type TEXT NOT NULL,
service TEXT NOT NULL,
amount NUMERIC(14,2)
NOT NULL,
reference TEXT UNIQUE,
status TEXT NOT NULL,
date TIMESTAMPTZ
NOT NULL DEFAULT NOW()
)
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
provider_reference TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
phone TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
network TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
plan TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
meter_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
meter_type TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
smartcard_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
cable_package TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
provider TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
response_data JSONB
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
created_at TIMESTAMPTZ
`);

await db(`
UPDATE transactions
SET created_at=date
WHERE created_at IS NULL
`);

await db(`
CREATE TABLE IF NOT EXISTS payments(
reference TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
email TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
amount_kobo BIGINT NOT NULL,
status TEXT NOT NULL,
credited BOOLEAN
NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ
NOT NULL DEFAULT NOW(),
credited_at TIMESTAMPTZ
)
`);

await db(`
CREATE TABLE IF NOT EXISTS admins(
id BIGSERIAL PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ
NOT NULL DEFAULT NOW()
)
`);

await db(`
CREATE TABLE IF NOT EXISTS admin_sessions(
token TEXT PRIMARY KEY,
admin_id BIGINT NOT NULL
REFERENCES admins(id)
ON DELETE CASCADE,
created_at TIMESTAMPTZ
NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ
NOT NULL
)
`);

await syncAdmin();

console.log(
"PostgreSQL database ready."
);
}

async function syncAdmin(){

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

console.log(
"ADMIN_EMAIL or ADMIN_PASSWORD is missing."
);

return;
}

const result=await db(`
SELECT id,email,password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)
`,[
ADMIN_EMAIL
]);

if(!result.rows.length){

await db(`
INSERT INTO admins(
email,
password_hash
)
VALUES($1,$2)
`,[
ADMIN_EMAIL,
hashPassword(ADMIN_PASSWORD)
]);

console.log(
"Admin account created."
);

}else{

await db(`
UPDATE admins
SET
email=$1,
password_hash=$2
WHERE id=$3
`,[
ADMIN_EMAIL,
hashPassword(ADMIN_PASSWORD),
result.rows[0].id
]);

console.log(
"Admin account synchronized."
);
}
}
