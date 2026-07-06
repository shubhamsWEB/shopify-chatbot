declare module "*.css";

// App Bridge app-nav web component is not exposed by @shopify/polaris-types.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": any;
  }
}
