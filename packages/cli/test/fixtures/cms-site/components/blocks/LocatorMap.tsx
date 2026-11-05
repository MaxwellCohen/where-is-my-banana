"use client";
import { GoogleMap, useJsApiLoader } from "@react-google-maps/api";

export default function LocatorMap({ offices }: { offices: { lat: number; lng: number }[] }) {
  const { isLoaded } = useJsApiLoader({ googleMapsApiKey: process.env.NEXT_PUBLIC_MAPS_KEY! });
  if (!isLoaded) return null;
  return <GoogleMap center={offices[0]} zoom={10} />;
}
