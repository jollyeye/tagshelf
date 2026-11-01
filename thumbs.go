package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var _ = gif.Decode // register decoders
var _ = png.Decode

const thumbMax = 360

var thumbSem = make(chan struct{}, func() int {
	n := runtime.NumCPU()
	if n < 2 {
		n = 2
	}
	if n > 6 {
		n = 6
	}
	return n
}())

var thumbExts = map[string]bool{".jpg": true, ".jpeg": true, ".jfif": true, ".png": true, ".gif": true}

func thumbPath(dataDir string, f *FileRec) string {
	return filepath.Join(dataDir, "thumbs", fmt.Sprintf("%s_%x_%x.jpg", f.ID, f.MTime, f.Size))
}

func makeThumb(src, dst string, ext string) error {
	thumbSem <- struct{}{}
	defer func() { <-thumbSem }()
	if _, err := os.Stat(dst); err == nil {
		return nil // another request produced it while we waited
	}
	fh, err := os.Open(src)
	if err != nil {
		return err
	}
	defer fh.Close()
	cfg, _, err := image.DecodeConfig(bufio.NewReader(fh))
	if err != nil {
		return err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > 250_000_000 {
		return errors.New("image dimensions not supported")
	}
	if _, err := fh.Seek(0, io.SeekStart); err != nil {
		return err
	}
	img, _, err := image.Decode(bufio.NewReaderSize(fh, 1<<20))
	if err != nil {
		return err
	}
	th := scaleBox(img, thumbMax)
	if ext == ".jpg" || ext == ".jpeg" || ext == ".jfif" {
		th = orient(th, exifOrientation(src))
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(out, th, &jpeg.Options{Quality: 82}); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	out.Close()
	return os.Rename(tmp, dst)
}

// scaleBox downsamples with area sampling and flattens transparency over a dark background.
func scaleBox(src image.Image, max int) *image.RGBA {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	longest := w
	if h > longest {
		longest = h
	}
	scale := float64(max) / float64(longest)
	if scale > 1 {
		scale = 1
	}
	dw, dh := int(float64(w)*scale+0.5), int(float64(h)*scale+0.5)
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	const bg = 0x1c1c
	for y := 0; y < dh; y++ {
		sy0 := b.Min.Y + y*h/dh
		sy1 := b.Min.Y + (y+1)*h/dh
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		stepY := (sy1 - sy0) / 4
		if stepY < 1 {
			stepY = 1
		}
		for x := 0; x < dw; x++ {
			sx0 := b.Min.X + x*w/dw
			sx1 := b.Min.X + (x+1)*w/dw
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			stepX := (sx1 - sx0) / 4
			if stepX < 1 {
				stepX = 1
			}
			var r, g, bl, a, n uint64
			for yy := sy0; yy < sy1; yy += stepY {
				for xx := sx0; xx < sx1; xx += stepX {
					cr, cg, cb, ca := src.At(xx, yy).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bl += uint64(cb)
					a += uint64(ca)
					n++
				}
			}
			r, g, bl, a = r/n, g/n, bl/n, a/n
			inv := 65535 - a
			o := dst.PixOffset(x, y)
			dst.Pix[o+0] = uint8((r + bg*inv/65535) >> 8)
			dst.Pix[o+1] = uint8((g + bg*inv/65535) >> 8)
			dst.Pix[o+2] = uint8((bl + bg*inv/65535) >> 8)
			dst.Pix[o+3] = 255
		}
	}
	return dst
}

func orient(src *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			so := src.PixOffset(x, y)
			do := dst.PixOffset(dx, dy)
			copy(dst.Pix[do:do+4], src.Pix[so:so+4])
		}
	}
	return dst
}

func exifOrientation(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	buf := make([]byte, 128*1024)
	n, _ := io.ReadFull(f, buf)
	b := buf[:n]
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return 1
		}
		m := b[i+1]
		if m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7) {
			i += 2
			continue
		}
		if m == 0xDA || m == 0xD9 {
			return 1
		}
		segLen := int(b[i+2])<<8 | int(b[i+3])
		if m == 0xE1 && i+10 <= len(b) && string(b[i+4:i+10]) == "Exif\x00\x00" {
			end := i + 2 + segLen
			if end > len(b) {
				end = len(b)
			}
			return tiffOrientation(b[i+10 : end])
		}
		i += 2 + segLen
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch strings.ToUpper(string(t[:2])) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off : off+2]))
	for k := 0; k < n; k++ {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 {
			v := int(bo.Uint16(t[e+8 : e+10]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}
