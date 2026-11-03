"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { createClient } from "contentful";

const client = createClient({ space: "abc", accessToken: "public" });

export default function Carousel({ slides }: { slides: { id: string; url: string }[] }) {
  const [i, setI] = useState(0);
  void client;
  return (
    <motion.div animate={{ opacity: 1 }}>
      <img src={slides[i].url} onClick={() => setI((i + 1) % slides.length)} />
    </motion.div>
  );
}
