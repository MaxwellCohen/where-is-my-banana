import dynamic from "next/dynamic";
import Hero from "./Hero";
import Carousel from "./Carousel";
import LocatorMap from "./LocatorMap";
import Calendly from "./Calendly";
import VideoPlayer from "./VideoPlayer";
import RichText from "./RichText";
import FAQ from "./FAQ";
import Testimonials from "./Testimonials";
import ServiceGrid from "./ServiceGrid";
import DoctorBio from "./DoctorBio";
import InsuranceList from "./InsuranceList";
import CTA from "./CTA";
import ContactForm from "./ContactForm";
import Gallery from "./Gallery";
import Stats from "./Stats";
import BlogList from "./BlogList";

export const ChatLauncher = dynamic(() => import("./ChatLauncher"), { ssr: false });
export const LazyCarousel = dynamic(() => import("./Carousel"), {
  loading: () => <div style={{ height: 400 }} />,
  ssr: false,
});

export const registry: Record<string, React.ComponentType<any>> = {
  hero: Hero,
  carousel: Carousel,
  locatorMap: LocatorMap,
  calendly: Calendly,
  video: VideoPlayer,
  richText: RichText,
  faq: FAQ,
  testimonials: Testimonials,
  serviceGrid: ServiceGrid,
  doctorBio: DoctorBio,
  insuranceList: InsuranceList,
  cta: CTA,
  contactForm: ContactForm,
  gallery: Gallery,
  stats: Stats,
  blogList: BlogList,
};
