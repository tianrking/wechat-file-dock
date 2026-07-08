import { nativeImage } from "electron";

const bluePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARUlEQVR4nGNgGAXDADDC9v///z8DJYCJgQH+QwAmQGxkZMTwH4gmgGgCkHwGxKQjNYNqBtUMqhlUM6hmUM0wCgAA7JQhHepblMYAAAAASUVORK5CYII=";

export function createTrayImage(): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(bluePixelPng, "base64"));
  image.setTemplateImage(false);
  return image;
}
