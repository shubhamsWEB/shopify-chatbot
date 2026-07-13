// Diagnose empty get_my_orders: run the customers + orders queries with the
// shop's offline token and print RAW responses (incl. errors that
// orders.server.ts swallows).
//   DB_URL=<prod-or-local url> SHOP=saleshq-dev.myshopify.com npx tsx scripts/debug-orders.ts
import { PrismaClient } from "@prisma/client";

const shop = process.env.SHOP;
if (!shop) throw new Error("set SHOP");
const db = new PrismaClient(process.env.DB_URL ? { datasources: { db: { url: process.env.DB_URL } } } : undefined);

const session = await db.session.findFirst({ where: { shop, isOnline: false } });
if (!session) throw new Error(`no offline session for ${shop}`);

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": session!.accessToken, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

console.log(`=== ${shop} — customers + order counts ===`);
const customers = await gql(`{ customers(first: 5, sortKey: UPDATED_AT, reverse: true) { nodes { id email numberOfOrders } } }`);
console.log(JSON.stringify(customers, null, 2).slice(0, 1500));

const first = (customers as any).data?.customers?.nodes?.find((c: any) => Number(c.numberOfOrders) > 0);
if (first) {
  console.log(`\n=== orders for ${first.id} (${first.numberOfOrders} orders) — EXACT app query ===`);
  const orders = await gql(
    `query CustomerOrders($id: ID!, $n: Int!) {
      customer(id: $id) {
        orders(first: $n, sortKey: PROCESSED_AT, reverse: true) {
          nodes { name processedAt displayFulfillmentStatus }
        }
      }
    }`,
    { id: first.id, n: 5 },
  );
  console.log(JSON.stringify(orders, null, 2).slice(0, 2000));
} else {
  console.log("\nno customer with orders found in first 5");
}
process.exit(0);
