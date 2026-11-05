import { PopupButton } from "react-calendly";

export default function Footer() {
  return (
    <footer>
      <PopupButton url="https://calendly.com/office" rootElement={document.body} text="Book" />
    </footer>
  );
}
