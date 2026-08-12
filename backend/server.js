const http=require("node:http"),crypto=require("node:crypto"),{Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv";
const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const pool=new Pool({
 connectionString:DATABASE_URL,
 ssl:DATABASE_URL?{rejectUnauthorized:false}:false
});

const db=(q,p=[])=>pool.query(q,p);

function send(res,status,data){
 res.writeHead(status,{
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type,Authorization"
 });
 res.end(JSON.stringify(data));
}

function readBody(req){
 return new Promise((resolve,reject)=>{
  let data="";
  req.on("data",chunk=>data+=chunk);
  req.on("end",()=>{
   try{resolve(data?JSON.parse(data):{})}
   catch(e){reject(e)}
  });
  req.on("error",reject);
 });
}

const token=()=>crypto.randomBytes(32).toString("hex");
const ref=()=>`BOLTIV-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const uid=()=>`BOLTIV-${crypto.randomBytes(10).toString("hex")}`;

function hash(password,salt=crypto.randomBytes(16).toString("hex")){
 return `${salt}:${crypto.scryptSync(password,salt,64).toString("hex")}`;
}

function verify(password,value){
 try{
  const [salt,key]=value.split(":");
  const hashed=crypto.scryptSync(password,salt,64).toString("hex");
  return crypto.timingSafeEqual(
   Buffer.from(hashed,"hex"),
   Buffer.from(key,"hex")
  );
 }catch{
  return false;
 }
}

function initials(name){
 const parts=String(name||"").trim().split(/\s+/).filter(Boolean);
 if(parts.length>1)return(parts[0][0]+parts.at(-1)[0]).toUpperCase();
 return(parts[0]?.[0]||"U").toUpperCase();
}

async function init(){
 if(!DATABASE_URL){
  console.log("DATABASE_URL is not configured.");
  return;
 }

 await db(`CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  initials TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
 )`);

 await db(`CREATE TABLE IF NOT EXISTS password_resets(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
 )`);

 await db(`CREATE TABLE IF NOT EXISTS user_sessions(
  token TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
 )`);

 await db(`CREATE TABLE IF NOT EXISTS wallets(
  user_id TEXT PRIMARY KEY,
  balance NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
 )`);

 await db(`CREATE TABLE IF NOT EXISTS transactions(
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  service TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  reference TEXT UNIQUE,
  status TEXT NOT NULL,
  date TIMESTAMPTZ DEFAULT NOW()
 )`);

 await db(`CREATE TABLE IF NOT EXISTS payments(
  reference TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  amount_kobo BIGINT NOT NULL,
  status TEXT NOT NULL,
  credited BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  credited_at TIMESTAMPTZ
 )`);

 await db(`CREATE TABLE IF NOT EXISTS admins(
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
 )`);

 await db(`CREATE TABLE IF NOT EXISTS admin_sessions(
  token TEXT PRIMARY KEY,
  admin_id BIGINT REFERENCES admins(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
 )`);

 if(ADMIN_EMAIL&&ADMIN_PASSWORD){
  const existing=await db(
   `SELECT id FROM admins WHERE LOWER(email)=LOWER($1)`,
   [ADMIN_EMAIL]
  );

  if(!existing.rows.length){
   await db(
    `INSERT INTO admins(email,password_hash) VALUES($1,$2)`,
    [ADMIN_EMAIL,hash(ADMIN_PASSWORD)]
   );
   console.log("Admin account created.");
  }
 }

 console.log("PostgreSQL database ready.");
}

async function getWallet(userId){
 const r=await db(
  `SELECT user_id,balance FROM wallets WHERE user_id=$1`,
  [userId]
 );
 if(!r.rows.length)return null;
 return{
  userId:r.rows[0].user_id,
  balance:Number(r.rows[0].balance)
 };
}

async function makeWallet(userId){
 await db(
  `INSERT INTO wallets(user_id,balance)
   VALUES($1,0)
   ON CONFLICT(user_id) DO NOTHING`,
  [userId]
 );
}

async function getTransactions(userId){
 const r=await db(
  `SELECT type,service,amount,reference,status,date
   FROM transactions
   WHERE user_id=$1
   ORDER BY date DESC`,
  [userId]
 );
 return r.rows.map(x=>({...x,amount:Number(x.amount)}));
}

async function findUserByEmail(email){
 const r=await db(
  `SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,
  [email]
 );
 return r.rows[0]||null;
}

async function userAuth(req){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer "))return null;

 const r=await db(
  `SELECT u.*
   FROM user_sessions s
   JOIN users u ON u.id=s.user_id
   WHERE s.token=$1 AND s.expires_at>NOW()`,
  [h.slice(7).trim()]
 );

 return r.rows[0]||null;
}

async function createUserSession(userId){
 const t=token();

 await db(
  `INSERT INTO user_sessions(token,user_id,expires_at)
   VALUES($1,$2,NOW()+INTERVAL '7 days')`,
  [t,userId]
 );

 return t;
}

async function createUser(name,phone,email,password){
 if(await findUserByEmail(email)){
  return{
   success:false,
   message:"An account with this email already exists."
  };
 }

 const r=await db(
  `INSERT INTO users(
   user_id,name,phone,email,password_hash,initials
  )
  VALUES($1,$2,$3,$4,$5,$6)
  RETURNING id,user_id,name,phone,email,initials,created_at`,
  [
   uid(),
   name,
   phone,
   email,
   hash(password),
   initials(name)
  ]
 );

 await makeWallet(r.rows[0].user_id);

 return{
  success:true,
  user:r.rows[0]
 };
}

async function loginUser(email,password){
 const user=await findUserByEmail(email);

 if(!user||!verify(password,user.password_hash)){
  return{
   success:false,
   message:"Invalid email or password."
  };
 }

 return{
  success:true,
  message:"Login successful.",
  token:await createUserSession(user.id),
  user:{
   id:user.user_id,
   name:user.name,
   phone:user.phone,
   email:user.email,
   initials:user.initials
  }
 };
}

async function forgotPassword(email){
 const user=await findUserByEmail(email);

 if(!user){
  return{
   success:true,
   message:"If the email exists, a reset request has been created."
  };
 }

 const t=token();

 await db(
  `UPDATE password_resets
   SET used=TRUE
   WHERE user_id=$1 AND used=FALSE`,
  [user.id]
 );

 await db(
  `INSERT INTO password_resets(user_id,token,expires_at)
   VALUES($1,$2,NOW()+INTERVAL '30 minutes')`,
  [user.id,t]
 );

 console.log("PASSWORD RESET TOKEN:",t);

 return{
  success:true,
  message:"Password reset request created.",
  token:t
 };
}

async function resetPassword(t,password){
 const r=await db(
  `SELECT u.id
   FROM password_resets p
   JOIN users u ON u.id=p.user_id
   WHERE p.token=$1
   AND p.used=FALSE
   AND p.expires_at>NOW()`,
  [t]
 );

 if(!r.rows.length){
  return{
   success:false,
   message:"Invalid or expired reset token."
  };
 }

 await db(
  `UPDATE users
   SET password_hash=$1,updated_at=NOW()
   WHERE id=$2`,
  [hash(password),r.rows[0].id]
 );

 await db(
  `UPDATE password_resets SET used=TRUE WHERE token=$1`,
  [t]
 );

 await db(
  `DELETE FROM user_sessions WHERE user_id=$1`,
  [r.rows[0].id]
 );

 return{
  success:true,
  message:"Password reset successfully."
 };
}

async function updateProfile(id,name,phone,email){
 const exists=await db(
  `SELECT id FROM users
   WHERE LOWER(email)=LOWER($1) AND user_id<>$2`,
  [email,id]
 );

 if(exists.rows.length){
  return{
   success:false,
   message:"Email is already in use."
  };
 }

 const r=await db(
  `UPDATE users
   SET name=$1,phone=$2,email=$3,initials=$4,updated_at=NOW()
   WHERE user_id=$5
   RETURNING user_id,name,phone,email,initials`,
  [
   name,
   phone,
   email,
   initials(name),
   id
  ]
 );

 if(!r.rows.length){
  return{
   success:false,
   message:"User not found."
  };
 }

 return{
  success:true,
  user:r.rows[0]
 };
}

async function changePassword(id,current,next){
 const r=await db(
  `SELECT password_hash FROM users WHERE user_id=$1`,
  [id]
 );

 if(!r.rows.length||!verify(current,r.rows[0].password_hash)){
  return{
   success:false,
   message:"Current password is incorrect."
  };
 }

 await db(
  `UPDATE users
   SET password_hash=$1,updated_at=NOW()
   WHERE user_id=$2`,
  [hash(next),id]
 );

 return{
  success:true,
  message:"Password changed successfully."
 };
}

async function paystack(path,options={}){
 const response=await fetch(
  `https://api.paystack.co${path}`,
  {
   ...options,
   headers:{
    Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type":"application/json",
    ...(options.headers||{})
   }
  }
 );

 return{
  status:response.status,
  data:await response.json()
 };
}

async function fundWallet(userId,email,amount){
 if(!PAYSTACK_SECRET_KEY){
  return{
   success:false,
   message:"Paystack is not configured on the server."
  };
 }

 const reference=ref();

 const result=await paystack(
  "/transaction/initialize",
  {
   method:"POST",
   body:JSON.stringify({
    email,
    amount:String(Math.round(amount*100)),
    currency:"NGN",
    reference,
    callback_url:`${FRONTEND_URL}/payment-success.html`,
    metadata:{
     userId,
     service:"BOLTIV Wallet Funding"
    }
   })
  }
 );

 if(!result.data.status){
  return{
   success:false,
   message:result.data.message||"Unable to initialize payment."
  };
 }

 await db(
  `INSERT INTO payments(
   reference,user_id,email,amount,amount_kobo,status
  )
  VALUES($1,$2,$3,$4,$5,'initialized')`,
  [
   reference,
   userId,
   email,
   amount,
   Math.round(amount*100)
  ]
 );

 return{
  success:true,
  message:"Payment initialized",
  reference,
  authorizationUrl:result.data.data.authorization_url,
  accessCode:result.data.data.access_code
 };
}

async function verifyPayment(reference){
 if(!PAYSTACK_SECRET_KEY){
  return{
   success:false,
   message:"Paystack is not configured on the server."
  };
 }

 const paymentResult=await db(
  `SELECT * FROM payments WHERE reference=$1`,
  [reference]
 );

 const payment=paymentResult.rows[0];

 if(!payment){
  return{
   success:false,
   message:"Payment reference not found."
  };
 }

 if(payment.credited){
  const w=await getWallet(payment.user_id);

  return{
   success:true,
   alreadyCredited:true,
   reference,
   balance:w?.balance||0
  };
 }

 const result=await paystack(
  `/transaction/verify/${encodeURIComponent(reference)}`,
  {method:"GET"}
 );

 if(!result.data.status){
  return{
   success:false,
   message:result.data.message||"Unable to verify payment."
  };
 }

 const transaction=result.data.data;

 if(transaction.status!=="success"){
  await db(
   `UPDATE payments SET status=$1 WHERE reference=$2`,
   [transaction.status,reference]
  );

  return{
   success:false,
   message:`Payment status: ${transaction.status}`,
   status:transaction.status
  };
 }

 if(
  transaction.currency!=="NGN"||
  Number(transaction.amount)!==Number(payment.amount_kobo)
 ){
  return{
   success:false,
   message:"Payment details do not match."
  };
 }

 const client=await pool.connect();

 try{
  await client.query("BEGIN");

  await client.query(
   `INSERT INTO wallets(user_id,balance)
    VALUES($1,0)
    ON CONFLICT(user_id) DO NOTHING`,
   [payment.user_id]
  );

  const walletResult=await client.query(
   `UPDATE wallets
    SET balance=balance+$1,updated_at=NOW()
    WHERE user_id=$2
    RETURNING balance`,
   [Number(payment.amount),payment.user_id]
  );

  await client.query(
   `INSERT INTO transactions(
    user_id,type,service,amount,reference,status
   )
   VALUES($1,'credit','Wallet Funding',$2,$3,'successful')
   ON CONFLICT(reference) DO NOTHING`,
   [
    payment.user_id,
    Number(payment.amount),
    reference
   ]
  );

  await client.query(
   `UPDATE payments
    SET status='success',credited=TRUE,credited_at=NOW()
    WHERE reference=$1`,
   [reference]
  );

  await client.query("COMMIT");

  return{
   success:true,
   message:"Wallet funded successfully.",
   reference,
   amount:Number(payment.amount),
   balance:Number(walletResult.rows[0].balance)
  };

 }catch(error){
  await client.query("ROLLBACK");
  throw error;
 }finally{
  client.release();
 }
}

async function debitWallet(userId,amount,service,reference=ref()){
 const client=await pool.connect();

 try{
  await client.query("BEGIN");

  const walletResult=await client.query(
   `SELECT balance
    FROM wallets
    WHERE user_id=$1
    FOR UPDATE`,
   [userId]
  );

  if(!walletResult.rows.length){
   await client.query("ROLLBACK");

   return{
    success:false,
    message:"Wallet not found."
   };
  }

  if(Number(walletResult.rows[0].balance)<amount){
   await client.query("ROLLBACK");

   return{
    success:false,
    message:"Insufficient wallet balance.",
    balance:Number(walletResult.rows[0].balance)
   };
  }

  const updated=await client.query(
   `UPDATE wallets
    SET balance=balance-$1,updated_at=NOW()
    WHERE user_id=$2
    RETURNING balance`,
   [amount,userId]
  );

  await client.query(
   `INSERT INTO transactions(
    user_id,type,service,amount,reference,status
   )
   VALUES($1,'debit',$2,$3,$4,'successful')`,
   [
    userId,
    service,
    amount,
    reference
   ]
  );

  await client.query("COMMIT");

  return{
   success:true,
   reference,
   balance:Number(updated.rows[0].balance)
  };

 }catch(error){
  await client.query("ROLLBACK");
  throw error;
 }finally{
  client.release();
 }
}

async function adminAuth(req){
 const h=req.headers.authorization||"";

 if(!h.startsWith("Bearer "))return null;

 const r=await db(
  `SELECT a.id,a.email
   FROM admin_sessions s
   JOIN admins a ON a.id=s.admin_id
   WHERE s.token=$1
   AND s.expires_at>NOW()`,
  [h.slice(7).trim()]
 );

 return r.rows[0]||null;
}

async function adminLogin(email,password){
 const r=await db(
  `SELECT * FROM admins
   WHERE LOWER(email)=LOWER($1)`,
  [email]
 );

 if(!r.rows.length){
  return{
   success:false,
   message:"Invalid admin credentials."
  };
 }

 if(!verify(password,r.rows[0].password_hash)){
  return{
   success:false,
   message:"Invalid admin credentials."
  };
 }

 const t=token();

 await db(
  `INSERT INTO admin_sessions(
   token,admin_id,expires_at
  )
  VALUES($1,$2,NOW()+INTERVAL '24 hours')`,
  [t,r.rows[0].id]
 );

 return{
  success:true,
  message:"Admin login successful.",
  token:t,
  admin:{
   id:r.rows[0].id,
   email:r.rows[0].email
  }
 };
}

async function adminUsers(){
 const r=await db(`
  SELECT
   u.user_id,
   u.name,
   u.phone,
   u.email,
   COALESCE(w.balance,0) AS balance,
   u.created_at,
   u.updated_at
  FROM users u
  LEFT JOIN wallets w
   ON w.user_id=u.user_id
  ORDER BY u.created_at DESC
  LIMIT 100
 `);

 return r.rows.map(x=>({
  user_id:x.user_id,
  name:x.name,
  phone:x.phone,
  email:x.email,
  balance:Number(x.balance),
  created_at:x.created_at,
  updated_at:x.updated_at
 }));
}

async function adminTransactions(){
 const r=await db(`
  SELECT id,user_id,type,service,amount,reference,status,date
  FROM transactions
  ORDER BY date DESC
  LIMIT 100
 `);

 return r.rows.map(x=>({
  ...x,
  amount:Number(x.amount)
 }));
}

async function adminPayments(){
 const r=await db(`
  SELECT reference,user_id,email,amount,status,credited,created_at,credited_at
  FROM payments
  ORDER BY created_at DESC
  LIMIT 100
 `);

 return r.rows.map(x=>({
  ...x,
  amount:Number(x.amount)
 }));
}

const server=http.createServer(async(req,res)=>{
 res.setHeader("Access-Control-Allow-Origin","*");
 res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,OPTIONS");
 res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");

 if(req.method==="OPTIONS"){
  res.writeHead(204);
  return res.end();
 }

 const url=new URL(req.url,"http://localhost");
 const path=url.pathname;

 try{

  if(req.method==="GET"&&path==="/api/health"){
   return send(res,200,{
    success:true,
    app:"BOLTIV",
    status:"online",
    paystack:PAYSTACK_SECRET_KEY?"configured":"not configured",
    database:DATABASE_URL?"configured":"not configured",
    admin:ADMIN_EMAIL?"configured":"not configured",
    message:"BOLTIV backend is running"
   });
  }

  if(req.method==="POST"&&path==="/api/auth/register"){
   const b=await readBody(req);

   const result=await createUser(
    String(b.name||"").trim(),
    String(b.phone||"").trim(),
    String(b.email||"").trim().toLowerCase(),
    String(b.password||"")
   );

   return send(res,result.success?201:400,result);
  }

  if(req.method==="POST"&&path==="/api/auth/login"){
   const b=await readBody(req);

   const result=await loginUser(
    String(b.email||"").trim().toLowerCase(),
    String(b.password||"")
   );

   return send(res,result.success?200:401,result);
  }

  if(req.method==="POST"&&path==="/api/auth/forgot-password"){
   const b=await readBody(req);

   return send(
    res,
    200,
    await forgotPassword(
     String(b.email||"").trim().toLowerCase()
    )
   );
  }

  if(req.method==="POST"&&path==="/api/auth/reset-password"){
   const b=await readBody(req);

   return send(
    res,
    200,
    await resetPassword(
     String(b.token||""),
     String(b.password||"")
    )
   );
  }

  if(req.method==="GET"&&path==="/api/auth/me"){
   const user=await userAuth(req);

   if(!user){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   return send(res,200,{
    success:true,
    user:{
     id:user.user_id,
     name:user.name,
     phone:user.phone,
     email:user.email,
     initials:user.initials
    }
   });
  }

  if(req.method==="POST"&&path==="/api/auth/logout"){
   const h=req.headers.authorization||"";

   if(h.startsWith("Bearer ")){
    await db(
     `DELETE FROM user_sessions WHERE token=$1`,
     [h.slice(7).trim()]
    );
   }

   return send(res,200,{
    success:true,
    message:"Logged out successfully."
   });
  }

  if(req.method==="PUT"&&path==="/api/profile"){
   const user=await userAuth(req);

   if(!user){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   const b=await readBody(req);

   return send(
    res,
    200,
    await updateProfile(
     user.user_id,
     String(b.name||"").trim(),
     String(b.phone||"").trim(),
     String(b.email||"").trim().toLowerCase()
    )
   );
  }

  if(req.method==="POST"&&path==="/api/profile/password"){
   const user=await userAuth(req);

   if(!user){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   const b=await readBody(req);

   return send(
    res,
    200,
    await changePassword(
     user.user_id,
     String(b.currentPassword||""),
     String(b.newPassword||"")
    )
   );
  }

  if(req.method==="POST"&&path==="/api/wallet/create"){
   const b=await readBody(req);
   const id=String(b.userId||"").trim();

   if(!id){
    return send(res,400,{
     success:false,
     message:"User ID is required."
    });
   }

   await makeWallet(id);
   const w=await getWallet(id);

   return send(res,200,{
    success:true,
    userId:id,
    balance:w.balance
   });
  }

  if(req.method==="GET"&&path==="/api/wallet"){
   const id=url.searchParams.get("userId");

   if(!id){
    return send(res,400,{
     success:false,
     message:"User ID is required."
    });
   }

   let w=await(!w){await makeWallet(id);w=await getWallet(id)}

   return send(res,200,{
    success:true,
    userId:id,
    balance:w.balance,
    transactions:await getTransactions(id)
   });
  }

  if(req.method==="POST"&&path==="/api/wallet/fund"){
   const b=await readBody(req);
   const id=String(b.userId||"").trim();
   const email=String(b.email||"").trim().toLowerCase();
   const amount=Number(b.amount);

   if(!id||!/^\S+@\S+\.\S+$/.test(email)||!Number.isFinite(amount)||amount<100){
    return send(res,400,{
     success:false,
     message:"Valid user, email and amount of at least ₦100 are required."
    });
   }

   await makeWallet(id);
   return send(res,200,await fundWallet(id,email,amount));
  }

  if(req.method==="GET"&&path==="/api/wallet/verify"){
   const reference=url.searchParams.get("reference");

   if(!reference){
    return send(res,400,{
     success:false,
     message:"Payment reference is required."
    });
   }

   return send(res,200,await verifyPayment(reference));
  }

  if(req.method==="POST"&&path==="/api/vtu/debit"){
   const user=await userAuth(req);

   if(!user){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   const b=await readBody(req);
   const amount=Number(b.amount);

   if(!Number.isFinite(amount)||amount<=0){
    return send(res,400,{
     success:false,
     message:"Valid amount is required."
    });
   }

   return send(
    res,
    200,
    await debitWallet(
     user.user_id,
     amount,
     String(b.service||"VTU Service"),
     String(b.reference||ref())
    )
   );
  }

  if(req.method==="POST"&&path==="/api/admin/login"){
   const b=await readBody(req);

   const result=await adminLogin(
    String(b.email||"").trim().toLowerCase(),
    String(b.password||"")
   );

   return send(res,result.success?200:401,result);
  }

  if(req.method==="GET"&&path==="/api/admin/me"){
   const admin=await adminAuth(req);

   if(!admin){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   return send(res,200,{
    success:true,
    admin
   });
  }

  if(req.method==="GET"&&path==="/api/admin/stats"){
   const admin=await adminAuth(req);

   if(!admin){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   const users=await db(`
    SELECT COUNT(*)::int AS count
    FROM users
   `);

   const wallets=await db(`
    SELECT COALESCE(SUM(balance),0) AS balance
    FROM wallets
   `);

   const transactions=await db(`
    SELECT COUNT(*)::int AS count
    FROM transactions
   `);

   const payments=await db(`
    SELECT
     COUNT(*)::int AS count,
     COALESCE(
      SUM(
       CASE
        WHEN status='success'
        THEN amount
        ELSE 0
       END
      ),0
     ) AS successful
    FROM payments
   `);

   return send(res,200,{
    success:true,
    stats:{
     users:users.rows[0].count,
     walletBalance:Number(wallets.rows[0].balance),
     transactions:transactions.rows[0].count,
     payments:payments.rows[0].count,
     successfulPayments:Number(payments.rows[0].successful)
    }
   });
  }

  if(req.method==="GET"&&path==="/api/admin/users"){
   const admin=await adminAuth(req);

   if(!admin){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   return send(res,200,{
    success:true,
    users:await adminUsers()
   });
  }

  if(req.method==="GET"&&path==="/api/admin/transactions"){
   const admin=await adminAuth(req);

   if(!admin){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   return send(res,200,{
    success:true,
    transactions:await adminTransactions()
   });
  }

  if(req.method==="GET"&&path==="/api/admin/payments"){
   const admin=await adminAuth(req);

   if(!admin){
    return send(res,401,{
     success:false,
     message:"Unauthorized."
    });
   }

   return send(res,200,{
    success:true,
    payments:await adminPayments()
   });
  }

  if(req.method==="POST"&&path==="/api/admin/logout"){
   const h=req.headers.authorization||"";

   if(h.startsWith("Bearer ")){
    await db(
     `DELETE FROM admin_sessions WHERE token=$1`,
     [h.slice(7).trim()]
    );
   }

   return send(res,200,{
    success:true,
    message:"Admin logged out."
   });
  }

  return send(res,404,{
   success:false,
   message:"API route not found"
  });

 }catch(error){
  console.error("BOLTIV ERROR:",error);

  return send(res,500,{
   success:false,
   message:"Server error."
  });
 }
});

init().then(()=>{
 server.listen(PORT,"0.0.0.0",()=>{
  console.log(`BOLTIV API running on port ${PORT}`);
 });
}).catch(error=>{
 console.error("STARTUP ERROR:",error);
 process.exit(1);
});

/* END OF BOLTIV BACKEND SERVER */
