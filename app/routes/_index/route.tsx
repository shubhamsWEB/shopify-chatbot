import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SalesHQ — Intent-driven shopping assistant</h1>
        <p className={styles.text}>
          Silently captures shopper behavior, builds a per-shopper intent profile in real time, and powers a grounded,
          proactive storefront assistant — plus an analytics dashboard for the merchant.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li><strong>Real-time intent</strong>. Web Pixel + webhooks → a live per-shopper intent profile.</li>
          <li><strong>Grounded assistant</strong>. Recommends, compares, and proactively helps — only with live store data.</li>
          <li><strong>Merchant analytics</strong>. Funnels, semantic cohorts, and an analytics assistant in your admin.</li>
        </ul>
      </div>
    </div>
  );
}
