"use strict";
/* BOLTIV Business Manager: database schema (Phase 1). Every tenant table carries business_id.
   Created lazily on first use, same style as the rest of BOLTIV (CREATE ... IF NOT EXISTS). */

const DEFAULT_PLANS = [
  { key: "starter", name: "Starter", tagline: "For small shops and solo businesses", price: 5000, branches: 1, members: 3, sort: 1,
    features: { pos: true, basic_inventory: true, advanced_inventory: false, reports: "basic", appointments: false, audit_export: false } },
  { key: "growth", name: "Growth", tagline: "For growing businesses with a team", price: 10000, branches: 3, members: 10, sort: 2,
    features: { pos: true, basic_inventory: true, advanced_inventory: true, reports: "full", appointments: true, audit_export: false } },
  { key: "enterprise", name: "Enterprise", tagline: "For multi-branch operations", price: 15000, branches: -1, members: -1, sort: 3,
    features: { pos: true, basic_inventory: true, advanced_inventory: true, reports: "full", appointments: true, audit_export: true } }
];

async function createSchema(db) {
  await db(`CREATE TABLE IF NOT EXISTS bm_plans(
    key TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT,
    price_monthly NUMERIC(14,2) NOT NULL CHECK(price_monthly>=0),
    max_branches INT NOT NULL DEFAULT 1, max_members INT NOT NULL DEFAULT 3,
    features JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const p of DEFAULT_PLANS) {
    // Only seeds missing plans; never overwrites what the admin has edited.
    await db(`INSERT INTO bm_plans(key,name,tagline,price_monthly,max_branches,max_members,features,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(key) DO NOTHING`,
      [p.key, p.name, p.tagline, p.price, p.branches, p.members, JSON.stringify(p.features), p.sort]);
  }
  await db(`CREATE TABLE IF NOT EXISTS bm_businesses(
    id BIGSERIAL PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, industry TEXT, phone TEXT, email TEXT,
    address TEXT, state TEXT, tin TEXT, currency TEXT NOT NULL DEFAULT 'NGN', status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_businesses_owner_idx ON bm_businesses(owner_user_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_branches(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), name TEXT NOT NULL,
    address TEXT, phone TEXT, is_main BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_branches_name_uq ON bm_branches(business_id, lower(name))`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_branches_main_uq ON bm_branches(business_id) WHERE is_main`);
  await db(`CREATE TABLE IF NOT EXISTS bm_members(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','accountant','cashier','staff')),
    branch_ids BIGINT[], status TEXT NOT NULL DEFAULT 'active', added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(business_id,user_id))`);
  await db(`CREATE INDEX IF NOT EXISTS bm_members_user_idx ON bm_members(user_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_subscriptions(
    business_id BIGINT PRIMARY KEY REFERENCES bm_businesses(id), plan_key TEXT NOT NULL REFERENCES bm_plans(key),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','trial','suspended')),
    period_months INT NOT NULL DEFAULT 1, starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_subscriptions_exp_idx ON bm_subscriptions(expires_at)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_subscription_payments(
    id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, business_id BIGINT NOT NULL REFERENCES bm_businesses(id),
    user_id TEXT NOT NULL, plan_key TEXT NOT NULL, period_months INT NOT NULL,
    list_amount NUMERIC(14,2) NOT NULL, discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0, discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_amount NUMERIC(14,2) NOT NULL DEFAULT 0, amount NUMERIC(14,2) NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paid', starts_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sub_pay_biz_idx ON bm_subscription_payments(business_id, created_at DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_audit_logs(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, user_id TEXT, actor_label TEXT, action TEXT NOT NULL,
    entity TEXT, entity_id TEXT, old_value JSONB, new_value JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_audit_biz_idx ON bm_audit_logs(business_id, created_at DESC)`);

  /* ===== Phase 2: products, stock, customers, sales ===== */
  await db(`ALTER TABLE bm_businesses ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0`);
  await db(`ALTER TABLE bm_businesses ADD COLUMN IF NOT EXISTS vat_inclusive BOOLEAN NOT NULL DEFAULT FALSE`);
  await db(`ALTER TABLE bm_businesses ADD COLUMN IF NOT EXISTS receipt_footer TEXT`);
  await db(`ALTER TABLE bm_businesses ADD COLUMN IF NOT EXISTS logo TEXT`);
  await db(`CREATE TABLE IF NOT EXISTS bm_products(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), name TEXT NOT NULL, sku TEXT, barcode TEXT, category TEXT,
    unit TEXT NOT NULL DEFAULT 'pcs', cost_price NUMERIC(14,2) NOT NULL DEFAULT 0, sell_price NUMERIC(14,2) NOT NULL CHECK(sell_price>=0),
    track_stock BOOLEAN NOT NULL DEFAULT TRUE, reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_products_sku_uq ON bm_products(business_id, lower(sku)) WHERE sku IS NOT NULL`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_products_barcode_uq ON bm_products(business_id, barcode) WHERE barcode IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_products_name_idx ON bm_products(business_id, lower(name))`);
  await db(`CREATE TABLE IF NOT EXISTS bm_stock(
    business_id BIGINT NOT NULL, branch_id BIGINT NOT NULL REFERENCES bm_branches(id), product_id BIGINT NOT NULL REFERENCES bm_products(id),
    quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(quantity>=0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(product_id, branch_id))`);
  await db(`CREATE INDEX IF NOT EXISTS bm_stock_branch_idx ON bm_stock(business_id, branch_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_stock_movements(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, branch_id BIGINT NOT NULL, product_id BIGINT NOT NULL, type TEXT NOT NULL,
    qty_change NUMERIC(14,3) NOT NULL, balance_after NUMERIC(14,3) NOT NULL, ref_type TEXT, ref_id TEXT, note TEXT, user_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_stock_mv_idx ON bm_stock_movements(business_id, product_id, id DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_customers(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, notes TEXT,
    balance NUMERIC(14,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_customers_phone_uq ON bm_customers(business_id, phone) WHERE phone IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_customers_name_idx ON bm_customers(business_id, lower(name))`);
  await db(`CREATE TABLE IF NOT EXISTS bm_customer_ledger(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, customer_id BIGINT NOT NULL REFERENCES bm_customers(id), type TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL, balance_after NUMERIC(14,2) NOT NULL, sale_id BIGINT, method TEXT, note TEXT, user_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_cust_ledger_idx ON bm_customer_ledger(business_id, customer_id, id DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_counters(business_id BIGINT NOT NULL, key TEXT NOT NULL, value BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(business_id,key))`);
  await db(`CREATE TABLE IF NOT EXISTS bm_sales(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT NOT NULL REFERENCES bm_branches(id), receipt_no TEXT NOT NULL,
    customer_id BIGINT REFERENCES bm_customers(id), cashier_user_id TEXT NOT NULL, cashier_name TEXT, status TEXT NOT NULL DEFAULT 'completed',
    subtotal NUMERIC(14,2) NOT NULL, discount NUMERIC(14,2) NOT NULL DEFAULT 0, tax NUMERIC(14,2) NOT NULL DEFAULT 0, total NUMERIC(14,2) NOT NULL,
    paid NUMERIC(14,2) NOT NULL DEFAULT 0, change_given NUMERIC(14,2) NOT NULL DEFAULT 0, balance_due NUMERIC(14,2) NOT NULL DEFAULT 0,
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0, vat_inclusive BOOLEAN NOT NULL DEFAULT FALSE, note TEXT, idempotency_key TEXT,
    voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_sales_receipt_uq ON bm_sales(business_id, receipt_no)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_sales_idem_uq ON bm_sales(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sales_time_idx ON bm_sales(business_id, created_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sales_branch_idx ON bm_sales(business_id, branch_id, created_at DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_sale_items(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, sale_id BIGINT NOT NULL REFERENCES bm_sales(id), product_id BIGINT, name TEXT NOT NULL, sku TEXT, unit TEXT,
    qty NUMERIC(14,3) NOT NULL, unit_price NUMERIC(14,2) NOT NULL, unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0, discount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(14,2) NOT NULL, tracked BOOLEAN NOT NULL DEFAULT FALSE)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sale_items_sale_idx ON bm_sale_items(sale_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_sale_payments(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, sale_id BIGINT NOT NULL REFERENCES bm_sales(id), method TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sale_pay_idx ON bm_sale_payments(sale_id)`);

  /* ===== Phase 3: suppliers, purchases, expenses, invoices ===== */
  await db(`CREATE TABLE IF NOT EXISTS bm_suppliers(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, notes TEXT,
    balance NUMERIC(14,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_suppliers_phone_uq ON bm_suppliers(business_id, phone) WHERE phone IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_suppliers_name_idx ON bm_suppliers(business_id, lower(name))`);
  await db(`CREATE TABLE IF NOT EXISTS bm_supplier_ledger(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, supplier_id BIGINT NOT NULL REFERENCES bm_suppliers(id), type TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL, balance_after NUMERIC(14,2) NOT NULL, purchase_id BIGINT, method TEXT, note TEXT, user_id TEXT, idem TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_sup_ledger_idx ON bm_supplier_ledger(business_id, supplier_id, id DESC)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_sup_ledger_idem_uq ON bm_supplier_ledger(business_id, idem) WHERE idem IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_purchases(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT NOT NULL REFERENCES bm_branches(id),
    supplier_id BIGINT REFERENCES bm_suppliers(id), purchase_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', reference TEXT,
    total NUMERIC(14,2) NOT NULL, paid NUMERIC(14,2) NOT NULL DEFAULT 0, balance_due NUMERIC(14,2) NOT NULL DEFAULT 0, pay_method TEXT,
    update_cost BOOLEAN NOT NULL DEFAULT FALSE, note TEXT, idempotency_key TEXT, voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT,
    created_by TEXT NOT NULL, created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_purchases_no_uq ON bm_purchases(business_id, purchase_no)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_purchases_idem_uq ON bm_purchases(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_purchases_time_idx ON bm_purchases(business_id, created_at DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_purchase_items(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, purchase_id BIGINT NOT NULL REFERENCES bm_purchases(id), product_id BIGINT NOT NULL, name TEXT NOT NULL, unit TEXT,
    qty NUMERIC(14,3) NOT NULL, unit_cost NUMERIC(14,2) NOT NULL, line_total NUMERIC(14,2) NOT NULL, tracked BOOLEAN NOT NULL DEFAULT TRUE)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_purchase_items_idx ON bm_purchase_items(purchase_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_expenses(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT REFERENCES bm_branches(id), category TEXT NOT NULL, description TEXT,
    amount NUMERIC(14,2) NOT NULL CHECK(amount>0), method TEXT NOT NULL DEFAULT 'cash', expense_date DATE NOT NULL, status TEXT NOT NULL DEFAULT 'active', idempotency_key TEXT,
    created_by TEXT NOT NULL, created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_expenses_date_idx ON bm_expenses(business_id, expense_date DESC)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_expenses_idem_uq ON bm_expenses(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_invoices(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT REFERENCES bm_branches(id), invoice_no TEXT,
    customer_id BIGINT REFERENCES bm_customers(id), customer_name TEXT NOT NULL, customer_phone TEXT, customer_email TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','void')), issue_date DATE NOT NULL, due_date DATE NOT NULL,
    subtotal NUMERIC(14,2) NOT NULL, discount NUMERIC(14,2) NOT NULL DEFAULT 0, tax NUMERIC(14,2) NOT NULL DEFAULT 0, total NUMERIC(14,2) NOT NULL,
    paid NUMERIC(14,2) NOT NULL DEFAULT 0, balance_due NUMERIC(14,2) NOT NULL, vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0, vat_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT, terms TEXT, idempotency_key TEXT, created_by TEXT NOT NULL, created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_invoices_no_uq ON bm_invoices(business_id, invoice_no) WHERE invoice_no IS NOT NULL`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_invoices_idem_uq ON bm_invoices(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE INDEX IF NOT EXISTS bm_invoices_status_idx ON bm_invoices(business_id, status, due_date)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_invoice_items(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, invoice_id BIGINT NOT NULL REFERENCES bm_invoices(id), description TEXT NOT NULL,
    qty NUMERIC(14,3) NOT NULL, unit_price NUMERIC(14,2) NOT NULL, line_total NUMERIC(14,2) NOT NULL)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_invoice_items_idx ON bm_invoice_items(invoice_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_invoice_payments(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, invoice_id BIGINT NOT NULL REFERENCES bm_invoices(id), amount NUMERIC(14,2) NOT NULL CHECK(amount>0),
    method TEXT NOT NULL, paid_on DATE NOT NULL, note TEXT, user_id TEXT, idem TEXT, status TEXT NOT NULL DEFAULT 'active', voided_at TIMESTAMPTZ, void_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_invoice_pay_idx ON bm_invoice_payments(invoice_id)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_invoice_pay_idem_uq ON bm_invoice_payments(business_id, idem) WHERE idem IS NOT NULL`);

  /* ===== Phase 4: staff, payroll, appointments, transfers, expiry lots ===== */
  await db(`ALTER TABLE bm_expenses ADD COLUMN IF NOT EXISTS source TEXT`);
  await db(`ALTER TABLE bm_customer_ledger ADD COLUMN IF NOT EXISTS idem TEXT`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_cust_ledger_idem_uq ON bm_customer_ledger(business_id, idem) WHERE idem IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_staff(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT REFERENCES bm_branches(id), name TEXT NOT NULL, phone TEXT, email TEXT,
    job_title TEXT, pay_type TEXT NOT NULL DEFAULT 'monthly', pay_amount NUMERIC(14,2) NOT NULL DEFAULT 0, start_date DATE, status TEXT NOT NULL DEFAULT 'active', notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_staff_biz_idx ON bm_staff(business_id, status)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_attendance(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, staff_id BIGINT NOT NULL REFERENCES bm_staff(id), work_date DATE NOT NULL, status TEXT NOT NULL, note TEXT, recorded_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(staff_id, work_date))`);
  await db(`CREATE INDEX IF NOT EXISTS bm_attendance_day_idx ON bm_attendance(business_id, work_date)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_payroll(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, staff_id BIGINT NOT NULL REFERENCES bm_staff(id), period TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL, bonus NUMERIC(14,2) NOT NULL DEFAULT 0,
    deductions NUMERIC(14,2) NOT NULL DEFAULT 0, net NUMERIC(14,2) NOT NULL CHECK(net>0), method TEXT NOT NULL, paid_on DATE NOT NULL, note TEXT, expense_id BIGINT REFERENCES bm_expenses(id),
    status TEXT NOT NULL DEFAULT 'active', idem TEXT, voided_at TIMESTAMPTZ, void_reason TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_payroll_staff_idx ON bm_payroll(business_id, staff_id, period)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_payroll_idem_uq ON bm_payroll(business_id, idem) WHERE idem IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_services(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), name TEXT NOT NULL, duration_min INT NOT NULL DEFAULT 30, price NUMERIC(14,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_services_name_uq ON bm_services(business_id, lower(name))`);
  await db(`CREATE TABLE IF NOT EXISTS bm_appointments(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), branch_id BIGINT NOT NULL REFERENCES bm_branches(id), customer_id BIGINT REFERENCES bm_customers(id),
    customer_name TEXT NOT NULL, customer_phone TEXT, service_id BIGINT REFERENCES bm_services(id), service_name TEXT NOT NULL, staff_id BIGINT REFERENCES bm_staff(id),
    starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL, price NUMERIC(14,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'booked', notes TEXT, sale_id BIGINT REFERENCES bm_sales(id),
    idempotency_key TEXT, created_by TEXT NOT NULL, created_by_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), cancel_reason TEXT)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_appt_time_idx ON bm_appointments(business_id, starts_at)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_appt_staff_idx ON bm_appointments(staff_id, starts_at)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_appt_idem_uq ON bm_appointments(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_transfers(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), transfer_no TEXT NOT NULL, from_branch_id BIGINT NOT NULL REFERENCES bm_branches(id),
    to_branch_id BIGINT NOT NULL REFERENCES bm_branches(id), status TEXT NOT NULL DEFAULT 'in_transit', note TEXT, idempotency_key TEXT, created_by TEXT NOT NULL, created_by_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), received_at TIMESTAMPTZ, received_by TEXT, cancelled_at TIMESTAMPTZ, cancelled_by TEXT, cancel_reason TEXT)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_transfers_no_uq ON bm_transfers(business_id, transfer_no)`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS bm_transfers_idem_uq ON bm_transfers(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await db(`CREATE TABLE IF NOT EXISTS bm_transfer_items(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL, transfer_id BIGINT NOT NULL REFERENCES bm_transfers(id), product_id BIGINT NOT NULL REFERENCES bm_products(id), name TEXT NOT NULL, unit TEXT, qty NUMERIC(14,3) NOT NULL)`);
  await db(`CREATE INDEX IF NOT EXISTS bm_transfer_items_idx ON bm_transfer_items(transfer_id)`);
  await db(`CREATE TABLE IF NOT EXISTS bm_lots(
    id BIGSERIAL PRIMARY KEY, business_id BIGINT NOT NULL REFERENCES bm_businesses(id), product_id BIGINT NOT NULL REFERENCES bm_products(id), branch_id BIGINT NOT NULL REFERENCES bm_branches(id),
    lot_no TEXT, expiry_date DATE NOT NULL, qty NUMERIC(14,3) NOT NULL CHECK(qty>0), source TEXT NOT NULL DEFAULT 'manual', ref_id TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS bm_lots_idx ON bm_lots(business_id, product_id, branch_id)`);
}

module.exports = { createSchema, DEFAULT_PLANS };
