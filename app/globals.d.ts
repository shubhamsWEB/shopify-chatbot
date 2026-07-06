declare module "*.css";

// App Bridge nav web component isn't in @shopify/polaris-types.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": any;
  }
}
