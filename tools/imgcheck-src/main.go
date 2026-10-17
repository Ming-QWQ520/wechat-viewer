// imgcheck: fully decode JPEG/PNG/GIF images to detect truncated or corrupt
// WeChat cache files. Usage: imgcheck.exe <file> [file...]
package main

import (
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
)

func main() {
	for _, path := range os.Args[1:] {
		f, err := os.Open(path)
		if err != nil {
			fmt.Printf("FAIL\t%s\topen: %v\n", path, err)
			continue
		}
		img, _, decodeErr := image.Decode(f)
		f.Close()
		if decodeErr != nil {
			fmt.Printf("FAIL\t%s\t%v\n", path, decodeErr)
			continue
		}
		bounds := img.Bounds()
		fmt.Printf("OK\t%s\t%d\t%d\n", path, bounds.Dx(), bounds.Dy())
	}
}
