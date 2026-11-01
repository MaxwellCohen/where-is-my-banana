import { render } from "preact";
import { useState } from "preact/hooks";
import HeavyChart from "./HeavyChart";
import { Modal } from "./Modal";

function App() {
  const [show, setShow] = useState(false);
  const [modal, setModal] = useState(false);
  return (
    <main>
      <button onClick={() => setShow(!show)}>Chart</button>
      <button onClick={() => setModal(!modal)}>Modal</button>
      {show && <HeavyChart />}
      {modal && <Modal />}
    </main>
  );
}

render(<App />, document.getElementById("app")!);
