"use client";

import { WidgetA } from "./widgets/WidgetA";
import { WidgetB } from "./widgets/WidgetB";
import { WidgetC } from "./widgets/WidgetC";
import { WidgetD } from "./widgets/WidgetD";
import { WidgetE } from "./widgets/WidgetE";
import { WidgetF } from "./widgets/WidgetF";
import { WidgetG } from "./widgets/WidgetG";

export const Components = {
  WidgetA,
  WidgetB,
  WidgetC,
  WidgetD,
  WidgetE,
  WidgetF,
  WidgetG,
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
};
