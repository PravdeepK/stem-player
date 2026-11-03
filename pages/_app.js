import Head from "next/head";
import "../styles/globals.css";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>Stem Player</title>
      </Head>
      <Component {...pageProps} />
    </>
  );
}
