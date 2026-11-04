// Shapes both backends use.

export interface Brightness {
  level: number;
  source: "backlight" | "video";
}

export interface AnkiConfig {
  url: string;
  deck: string;
}
