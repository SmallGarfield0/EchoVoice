type Stripe = string | readonly [color: string, weight: number];

export type BuiltInGraphicEmoji = {
  id: string;
  value: string;
  category: "flags";
  keywords: string[];
  imageURL: string;
};

const width = 60;
const height = 36;

function svgDataURL(body: string) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

function horizontalStripes(stripes: readonly Stripe[]) {
  const normalized = stripes.map((stripe) => (
    typeof stripe === "string" ? { color: stripe, weight: 1 } : { color: stripe[0], weight: stripe[1] }
  ));
  const totalWeight = normalized.reduce((sum, stripe) => sum + stripe.weight, 0);
  let offset = 0;
  const body = normalized.map((stripe, index) => {
    const stripeHeight = index === normalized.length - 1
      ? height - offset
      : height * stripe.weight / totalWeight;
    const rect = `<rect width="${width}" height="${stripeHeight}" y="${offset}" fill="${stripe.color}"/>`;
    offset += stripeHeight;
    return rect;
  }).join("");
  return svgDataURL(body);
}

function progressPrideFlag() {
  const rainbow = horizontalStripeBody(["#E40303", "#FF8C00", "#FFED00", "#008026", "#004DFF", "#750787"]);
  const chevrons = ["#000000", "#613915", "#74D7EE", "#FFAFC8", "#FFFFFF"]
    .map((color, index) => {
      const edge = index * 3.6;
      const nextEdge = edge + 4;
      const tip = 18 + index * 3.6;
      return `<polygon points="${edge},0 ${nextEdge},0 ${tip + 4},18 ${nextEdge},36 ${edge},36 ${tip},18" fill="${color}"/>`;
    })
    .join("");
  return svgDataURL(rainbow + chevrons);
}

function horizontalStripeBody(colors: readonly string[]) {
  const stripeHeight = height / colors.length;
  return colors.map((color, index) => (
    `<rect width="${width}" height="${index === colors.length - 1 ? height - stripeHeight * index : stripeHeight}" y="${stripeHeight * index}" fill="${color}"/>`
  )).join("");
}

function intersexFlag() {
  return svgDataURL(
    `<rect width="${width}" height="${height}" fill="#FFD800"/>` +
    '<circle cx="30" cy="18" r="9" fill="none" stroke="#7902AA" stroke-width="3.5"/>'
  );
}

function demiFlag(accent: string) {
  return svgDataURL(
    '<rect width="60" height="15" fill="#FFFFFF"/>' +
    `<rect width="60" height="6" y="15" fill="${accent}"/>` +
    '<rect width="60" height="15" y="21" fill="#A4A4A4"/>' +
    '<polygon points="0,0 25,18 0,36" fill="#000000"/>'
  );
}

function token(id: string) {
  return `<:evb:${id}>`;
}

function graphicEmoji(id: string, keywords: string[], imageURL: string): BuiltInGraphicEmoji {
  return { id, value: token(id), category: "flags", keywords, imageURL };
}

export const prideFlagEmojis: BuiltInGraphicEmoji[] = [
  graphicEmoji("progress", ["progress pride", "inclusive pride", "lgbt", "lgbtq", "进步骄傲旗", "包容骄傲旗"], progressPrideFlag()),
  graphicEmoji("lesbian", ["lesbian pride", "sunset lesbian", "女同性恋", "女同骄傲旗"], horizontalStripes([
    "#D52D00", "#EF7627", "#FF9A56", "#FFFFFF", "#D162A4", "#B55690", "#A30262"
  ])),
  graphicEmoji("gay_men", ["gay men pride", "mlm", "men loving men", "男同性恋", "男同骄傲旗"], horizontalStripes([
    "#078D70", "#26CEAA", "#98E8C1", "#FFFFFF", "#7BADE2", "#5049CC", "#3D1A78"
  ])),
  graphicEmoji("bisexual", ["bisexual pride", "bi", "双性恋", "双性恋骄傲旗"], horizontalStripes([
    ["#D60270", 2], ["#9B4F96", 1], ["#0038A8", 2]
  ])),
  graphicEmoji("pansexual", ["pansexual pride", "pan", "泛性恋", "泛性恋骄傲旗"], horizontalStripes([
    "#FF218C", "#FFD800", "#21B1FF"
  ])),
  graphicEmoji("asexual", ["asexual pride", "ace", "无性恋", "无性恋骄傲旗"], horizontalStripes([
    "#000000", "#A3A3A3", "#FFFFFF", "#800080"
  ])),
  graphicEmoji("aromantic", ["aromantic pride", "aro", "无浪漫倾向", "无浪漫倾向骄傲旗"], horizontalStripes([
    "#3DA542", "#A7D379", "#FFFFFF", "#A9A9A9", "#000000"
  ])),
  graphicEmoji("aroace", ["aromantic asexual", "aro ace", "无浪漫倾向无性恋", "aroace骄傲旗"], horizontalStripes([
    "#E28C00", "#ECCB27", "#FFFFFF", "#62AEDC", "#203856"
  ])),
  graphicEmoji("nonbinary", ["nonbinary pride", "non binary", "nb", "非二元性别", "非二元骄傲旗"], horizontalStripes([
    "#FFF430", "#FFFFFF", "#9C59D1", "#2D2D2D"
  ])),
  graphicEmoji("intersex", ["intersex pride", "间性", "间性骄傲旗"], intersexFlag()),
  graphicEmoji("agender", ["agender pride", "无性别", "无性别骄傲旗"], horizontalStripes([
    "#000000", "#B9B9B9", "#FFFFFF", "#B8F483", "#FFFFFF", "#B9B9B9", "#000000"
  ])),
  graphicEmoji("genderfluid", ["genderfluid pride", "gender fluid", "流动性别", "流动性别骄傲旗"], horizontalStripes([
    "#FF76A4", "#FFFFFF", "#C011D7", "#000000", "#2F3CBE"
  ])),
  graphicEmoji("genderqueer", ["genderqueer pride", "gender queer", "酷儿性别", "酷儿性别骄傲旗"], horizontalStripes([
    "#B57EDC", "#FFFFFF", "#4A8123"
  ])),
  graphicEmoji("polysexual", ["polysexual pride", "多性恋", "多性恋骄傲旗"], horizontalStripes([
    "#F61CB9", "#07D569", "#1C92F6"
  ])),
  graphicEmoji("omnisexual", ["omnisexual pride", "omni", "全性恋", "全性恋骄傲旗"], horizontalStripes([
    "#FF9ACE", "#FF53BF", "#200044", "#6760FE", "#8EA6FF"
  ])),
  graphicEmoji("demisexual", ["demisexual pride", "demi sexual", "半性恋", "半性恋骄傲旗"], demiFlag("#6E0071")),
  graphicEmoji("demiromantic", ["demiromantic pride", "demi romantic", "半浪漫倾向", "半浪漫倾向骄傲旗"], demiFlag("#3DA542"))
];
