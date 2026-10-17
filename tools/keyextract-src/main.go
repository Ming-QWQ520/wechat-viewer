// wechat-keys: read-only WeChat 4.x (WCDB/SQLCipher4) database key extractor.
// Scans the running Weixin.exe process for the WCDB Config.Cipher objects,
// decodes the XOR-masked x'<key><salt>' blobs, and verifies each candidate with
// SQLCipher page-1 HMAC. Writes a JSON key map for the local decryption step.
//
// Usage: wechat-keys.exe [-dbdir <db_storage path>] [-out keys.json]
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const (
	processVMRead      = 0x0010
	processQueryInfo   = 0x0400
	memCommit          = 0x1000
	pageNoAccess       = 0x01
	pageGuard          = 0x100
	th32csSnapProcess  = 0x00000002
	maxRawAddress      = 0x7FFFFFFF0000
	pageSize           = 4096
	reserveSize        = 80
	hmacSize           = 64
	configBlobMax      = 1024
	configCipherName   = "com.Tencent.WCDB.Config.Cipher"
	memoryChunkSize    = 8 * 1024 * 1024
	configMaxUserAddr  = 0x0000800000000000
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
	procReadProcessMemory        = kernel32.NewProc("ReadProcessMemory")
	procVirtualQueryEx           = kernel32.NewProc("VirtualQueryEx")
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
)

type memoryBasicInformation struct {
	BaseAddress       uintptr
	AllocationBase    uintptr
	AllocationProtect uint32
	PartitionID       uint16
	RegionSize        uintptr
	State             uint32
	Protect           uint32
	Type              uint32
}

type processEntry32W struct {
	Size              uint32
	Usage             uint32
	ProcessID         uint32
	DefaultHeapID     uintptr
	ModuleID          uint32
	Threads           uint32
	ParentProcessID   uint32
	PriClassBase      int32
	Flags             uint32
	ExeFile           [260]uint16
}

type dbFile struct {
	Rel    string
	Path   string
	Salt   string
	Page1  []byte
}

type keyRecord struct {
	EncKey string `json:"enc_key"`
	Salt   string `json:"salt"`
	SizeMB float64 `json:"size_mb"`
}

type output struct {
	DBDir          string               `json:"db_dir"`
	Keys           map[string]keyRecord `json:"keys"`
	ImageAESKey    string               `json:"image_aes_key,omitempty"`
	ImageXORKey    int                  `json:"image_xor_key,omitempty"`
	EmoticonAESKey string               `json:"emoticon_aes_key,omitempty"`
	AccountSeed    string               `json:"account_seed,omitempty"`
}

// The fixed XOR mask used by WeChat 4.1+ around Config.Cipher key strings.
var configXorMask = []byte{
	0xd2, 0xc7, 0x44, 0x24, 0x58, 0x02, 0x00, 0x00,
	0x00, 0x48, 0x89, 0x44, 0x24, 0x50, 0x48, 0x8b,
	0x45, 0x00, 0x48, 0x84, 0x4c, 0x24, 0x48, 0x48,
	0x89, 0x44, 0x25, 0x40, 0x48, 0x58, 0x4c, 0x24,
}

var configLiteralRe = regexp.MustCompile(`(?i)x'([0-9a-f]{64,192})'`)

func xorRepeat(data, mask []byte) []byte {
	out := make([]byte, len(data))
	for i := range data {
		out[i] = data[i] ^ mask[i%len(mask)]
	}
	return out
}

func u64(data []byte, off int) uint64 {
	if off < 0 || off+8 > len(data) {
		return 0
	}
	return binary.LittleEndian.Uint64(data[off:])
}

func main() {
	dbDir := flagString("-dbdir", "")
	outPath := flagString("-out", "keys.json")

	if dbDir == "" {
		dbDir = autodetectDBDir()
	}
	if dbDir == "" {
		fatalf("cannot locate WeChat db_storage dir; pass -dbdir")
	}
	absDB, err := filepath.Abs(dbDir)
	if err != nil {
		fatalf("bad db dir: %v", err)
	}
	dbs, salts := collectDBs(absDB)
	fmt.Printf("[*] db_storage: %s\n", absDB)
	fmt.Printf("[*] databases: %d, distinct salts: %d\n", len(dbs), len(salts))

	pids := findProcessIDs("Weixin.exe")
	if len(pids) == 0 {
		fatalf("Weixin.exe is not running: log in to WeChat and retry")
	}
	sort.Ints(pids)
	fmt.Printf("[*] Weixin.exe pids: %v\n", pids)

	remaining := make(map[string]struct{}, len(salts))
	for _, s := range salts {
		remaining[s] = struct{}{}
	}
	found := make(map[string]string) // salt -> enc key hex

	for _, pid := range pids {
		if len(remaining) == 0 {
			break
		}
		if err := scanProcess(pid, dbs, remaining, found); err != nil {
			fmt.Printf("[!] pid %d: %v\n", pid, err)
		}
	}

	if len(found) == 0 {
		fatalf("no verified database keys found (is WeChat logged in?)")
	}

	result := output{DBDir: absDB, Keys: map[string]keyRecord{}}
	for _, db := range dbs {
		if key, ok := found[db.Salt]; ok {
			info, _ := os.Stat(db.Path)
			sizeMB := 0.0
			if info != nil {
				sizeMB = float64(info.Size()) / (1024 * 1024)
			}
			result.Keys[db.Rel] = keyRecord{EncKey: key, Salt: db.Salt, SizeMB: sizeMB}
		}
	}

	seed, emoKey, derivedImg, derivedXor := scanEmoticonSeed(pids, absDB)
	if seed != "" {
		result.AccountSeed = seed
		result.EmoticonAESKey = hex.EncodeToString(emoKey)
		fmt.Printf("[+] account seed: %s (emoticon AES key %s)\n", seed, result.EmoticonAESKey)
		if derivedImg != "" {
			result.ImageAESKey = derivedImg
			result.ImageXORKey = derivedXor
			fmt.Printf("[+] image AES key derived from seed: %s (xor %#x)\n", derivedImg, derivedXor)
		} else {
			fmt.Println("[!] seed found; image key formula not verified against a V2 sample")
		}
	} else {
		fmt.Println("[!] account seed not found in memory; emoticons will show placeholders")
	}

	if result.ImageAESKey == "" {
		if imgKey, xorKey := scanImageKey(pids, absDB); imgKey != "" {
			result.ImageAESKey = imgKey
			result.ImageXORKey = xorKey
			fmt.Printf("[+] image AES key: %s (xor %#x)\n", imgKey, xorKey)
		} else {
			fmt.Println("[!] image AES key not found (open an image in WeChat, then rerun to enable full-size images)")
		}
	}

	payload, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, payload, 0o600); err != nil {
		fatalf("write %s: %v", outPath, err)
	}
	fmt.Printf("[+] verified keys: %d/%d -> %s\n", len(found), len(dbs), outPath)
}

func flagString(name, def string) string {
	args := os.Args[1:]
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			return args[i+1]
		}
	}
	return def
}

func fatalf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[x] "+format+"\n", a...)
	os.Exit(1)
}

// autodetectDBDir finds the active WeChat 4.x db_storage directory.
func autodetectDBDir() string {
	home, _ := os.UserHomeDir()
	var roots []string
	if home != "" {
		roots = append(roots, filepath.Join(home, "Documents", "xwechat_files"))
	}
	for _, drive := range []string{"C:", "D:", "E:", "F:"} {
		roots = append(roots, drive+`\xwechat_files`)
	}
	best := ""
	bestSize := int64(0)
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dbDir := filepath.Join(root, entry.Name(), "db_storage")
			msgDir := filepath.Join(dbDir, "message")
			infos, err := os.ReadDir(msgDir)
			if err != nil {
				continue
			}
			var total int64
			for _, info := range infos {
				if st, err := info.Info(); err == nil {
					total += st.Size()
				}
			}
			if total > bestSize {
				bestSize = total
				best = dbDir
			}
		}
	}
	return best
}

func collectDBs(dbDir string) ([]dbFile, []string) {
	var dbs []dbFile
	saltSet := map[string]struct{}{}
	filepath.WalkDir(dbDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".db") {
			return nil
		}
		rel, err := filepath.Rel(dbDir, path)
		if err != nil {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		page := make([]byte, pageSize)
		n, _ := f.Read(page)
		f.Close()
		if n < pageSize {
			return nil
		}
		salt := hex.EncodeToString(page[:16])
		dbs = append(dbs, dbFile{Rel: rel, Path: path, Salt: salt, Page1: page})
		saltSet[salt] = struct{}{}
		return nil
	})
	salts := make([]string, 0, len(saltSet))
	for s := range saltSet {
		salts = append(salts, s)
	}
	sort.Strings(salts)
	return dbs, salts
}

// findProcessIDs returns PIDs of running processes with the given exe name.
func findProcessIDs(exeName string) []int {
	snapshot, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if snapshot == uintptr(syscall.InvalidHandle) {
		return nil
	}
	defer procCloseHandle.Call(snapshot)

	var entry processEntry32W
	entry.Size = uint32(unsafe.Sizeof(entry))
	var pids []int
	ok, _, _ := procProcess32FirstW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		name := syscall.UTF16ToString(entry.ExeFile[:])
		if strings.EqualFold(name, exeName) {
			pids = append(pids, int(entry.ProcessID))
		}
		ok, _, _ = procProcess32NextW.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	}
	return pids
}

type regionReader struct {
	handle uintptr
}

func (r regionReader) read(addr uint64, size int) []byte {
	if size <= 0 {
		return nil
	}
	buf := make([]byte, size)
	var read uintptr
	ok, _, _ := procReadProcessMemory.Call(r.handle, uintptr(addr), uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&read)))
	if ok == 0 || read == 0 {
		return nil
	}
	return buf[:read]
}

func (r regionReader) regions() [][2]uint64 {
	var out [][2]uint64
	addr := uint64(0)
	for {
		var mbi memoryBasicInformation
		q, _, _ := procVirtualQueryEx.Call(r.handle, uintptr(addr), uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi))
		if q == 0 {
			break
		}
		base := uint64(mbi.BaseAddress)
		size := uint64(mbi.RegionSize)
		if mbi.State == memCommit && (mbi.Protect&pageNoAccess) == 0 && (mbi.Protect&pageGuard) == 0 && (mbi.Protect&0xEE) != 0 && size > 0 {
			out = append(out, [2]uint64{base, size})
		}
		if size == 0 {
			break
		}
		addr = base + size
		if addr >= maxRawAddress {
			break
		}
	}
	return out
}

// forEachChunk scans every readable region in chunks.
func (r regionReader) forEachChunk(fn func(base uint64, data []byte)) {
	for _, region := range r.regions() {
		base, size := region[0], region[1]
		for off := uint64(0); off < size; off += memoryChunkSize {
			length := uint64(memoryChunkSize)
			if size-off < length {
				length = size - off
			}
			data := r.read(base+off, int(length))
			if len(data) > 0 {
				fn(base+off, data)
			}
		}
	}
}

func scanProcess(pid int, dbs []dbFile, remaining map[string]struct{}, found map[string]string) error {
	handle, _, _ := procOpenProcess.Call(processVMRead|processQueryInfo, 0, uintptr(pid))
	if handle == 0 {
		return fmt.Errorf("OpenProcess failed")
	}
	defer procCloseHandle.Call(handle)
	reader := regionReader{handle: handle}

	needle := []byte(configCipherName)
	var needleAddresses []uint64
	reader.forEachChunk(func(base uint64, data []byte) {
		idx := 0
		for {
			pos := bytes.Index(data[idx:], needle)
			if pos < 0 {
				return
			}
			needleAddresses = append(needleAddresses, base+uint64(idx+pos))
			idx += pos + 1
		}
	})
	fmt.Printf("[*] pid %d: Config.Cipher strings: %d\n", pid, len(needleAddresses))
	if len(needleAddresses) == 0 {
		return nil
	}

	// The std::string object reference is a (pointer, length) pair in memory.
	pairLen := uint64(len(needle))
	var pairs [][]byte
	for _, addr := range needleAddresses {
		pair := make([]byte, 16)
		binary.LittleEndian.PutUint64(pair[0:], addr)
		binary.LittleEndian.PutUint64(pair[8:], pairLen)
		pairs = append(pairs, pair)
	}

	type candidate struct {
		keyHex string
		salt   string
	}
	seen := map[candidate]struct{}{}
	candidates := []candidate{}

	processNode := func(qaddr uint64) {
		node := reader.read(qaddr-0x10, 0x50)
		if len(node) < 0x40 {
			return
		}
		ref := u64(node, 0x10)
		refLen := u64(node, 0x18)
		if refLen != pairLen {
			return
		}
		isKnown := false
		for _, addr := range needleAddresses {
			if addr == ref {
				isKnown = true
				break
			}
		}
		if !isKnown {
			return
		}
		configPtr := u64(node, 0x28)
		if configPtr < 0x10000 || configPtr >= configMaxUserAddr {
			return
		}
		obj := reader.read(configPtr+0x88, 0x28)
		if len(obj) < 0x18 {
			return
		}
		dataPtr := u64(obj, 0x08)
		dataLen := u64(obj, 0x10)
		if dataLen == 0 || dataLen > configBlobMax || dataPtr < 0x10000 || dataPtr >= configMaxUserAddr {
			return
		}
		blob := reader.read(dataPtr, int(dataLen))
		if blob == nil || len(blob) != int(dataLen) {
			return
		}
		decoded := xorRepeat(blob, configXorMask)
		for _, m := range configLiteralRe.FindAllStringSubmatch(string(decoded), -1) {
			run := strings.ToLower(m[1])
			starts := []int{0}
			if len(run) > 96 {
				for s := 0; s+64 <= len(run); s += 32 {
					starts = append(starts, s)
				}
				starts = append(starts, len(run)-64)
			}
			for _, start := range starts {
				if start < 0 || start+64 > len(run) {
					continue
				}
				keyHex := run[start : start+64]
				if !probableKey(keyHex) {
					continue
				}
				embeddedSalt := ""
				if start+96 <= len(run) {
					embeddedSalt = run[start+64 : start+96]
				}
				c := candidate{keyHex: keyHex, salt: embeddedSalt}
				if _, ok := seen[c]; ok {
					continue
				}
				seen[c] = struct{}{}
				candidates = append(candidates, c)
			}
		}
	}

	for _, pair := range pairs {
		reader.forEachChunk(func(base uint64, data []byte) {
			idx := 0
			for {
				pos := bytes.Index(data[idx:], pair)
				if pos < 0 {
					return
				}
				processNode(base + uint64(idx+pos))
				idx += pos + 1
			}
		})
	}
	fmt.Printf("[*] pid %d: candidates: %d\n", pid, len(candidates))

	for _, c := range candidates {
		if len(remaining) == 0 {
			return nil
		}
		keyBytes, err := hex.DecodeString(c.keyHex)
		if err != nil {
			continue
		}
		targets := dbs
		if c.salt != "" {
			var filtered []dbFile
			for _, db := range dbs {
				if db.Salt == c.salt {
					filtered = append(filtered, db)
				}
			}
			if len(filtered) > 0 {
				targets = filtered
			}
		}
		for _, db := range targets {
			if _, needed := remaining[db.Salt]; !needed {
				continue
			}
			if verifyEncKey(keyBytes, db.Page1) {
				found[db.Salt] = c.keyHex
				delete(remaining, db.Salt)
				fmt.Printf("[+] key verified: %s\n", db.Rel)
			}
		}
	}
	return nil
}

func probableKey(keyHex string) bool {
	raw, err := hex.DecodeString(keyHex)
	if err != nil || len(raw) != 32 {
		return false
	}
	distinct := map[byte]struct{}{}
	for _, b := range raw {
		distinct[b] = struct{}{}
	}
	if len(distinct) < 15 {
		return false
	}
	allZero, allFF := true, true
	for _, b := range raw {
		if b != 0 {
			allZero = false
		}
		if b != 0xFF {
			allFF = false
		}
	}
	return !allZero && !allFF
}

// verifyEncKey checks the SQLCipher v4 page-1 HMAC (reserve 80: nonce 16 + HMAC-SHA512 64).
func verifyEncKey(encKey, page1 []byte) bool {
	if len(page1) < pageSize {
		return false
	}
	salt := page1[:16]
	macSalt := make([]byte, 16)
	for i, b := range salt {
		macSalt[i] = b ^ 0x3a
	}
	macKey := pbkdf2SHA512(encKey, macSalt, 2, 32)
	mac := hmac.New(sha512.New, macKey)
	mac.Write(page1[16 : pageSize-reserveSize+16])
	var pgno [4]byte
	binary.LittleEndian.PutUint32(pgno[:], 1)
	mac.Write(pgno[:])
	expected := mac.Sum(nil)
	stored := page1[pageSize-hmacSize:]
	return hmac.Equal(expected, stored)
}

func pbkdf2SHA512(password, salt []byte, iterations, keyLen int) []byte {
	prf := hmac.New(sha512.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen
	var out []byte
	var block [4]byte
	for i := 1; i <= numBlocks; i++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(block[:], uint32(i))
		prf.Write(block[:])
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for j := 1; j < iterations; j++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(nil)
			for k := range t {
				t[k] ^= u[k]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// ---------- V2 image AES key scan ----------

var imageMagics = [][]byte{
	{0xFF, 0xD8, 0xFF},
	{0x89, 0x50, 0x4E, 0x47},
	{0x47, 0x49, 0x46, 0x38},
	{0x52, 0x49, 0x46, 0x46},
	{0x42, 0x4D},
	{'w', 'x', 'g', 'f'},
}

// findV2Sample locates a local V2-format image (magic 07 08 56 32) to validate keys against.
func findV2Sample(dbDir string) []byte {
	attach := filepath.Join(filepath.Dir(dbDir), "msg", "attach")
	var sample []byte
	filepath.WalkDir(attach, func(path string, d os.DirEntry, err error) error {
		if err != nil || sample != nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".dat") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 31 {
			return nil
		}
		if data[0] == 0x07 && data[1] == 0x08 && data[2] == 0x56 && (data[3] == 0x32 || data[3] == 0x31) {
			sample = data
		}
		return nil
	})
	return sample
}

// imageHeadValid reports whether a decrypted first block looks like an image start.
func imageHeadValid(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	if data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		switch data[3] {
		case 0xE0, 0xE1, 0xE2, 0xDB, 0xEE, 0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xED, 0xFE:
			return true
		}
		return false
	}
	if data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 {
		return true
	}
	if data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x38 {
		return true
	}
	if data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46 {
		return true
	}
	if data[0] == 'w' && data[1] == 'x' && data[2] == 'g' && data[3] == 'f' {
		return true
	}
	return false
}

// quickHeadCheck decrypts only the first AES block of the V2 sample.
func quickHeadCheck(sample, key []byte) bool {
	if len(sample) < 31 {
		return false
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return false
	}
	var out [16]byte
	blk.Decrypt(out[:], sample[15:31])
	return imageHeadValid(out[:])
}

// tryImageKey validates a candidate 16-byte AES key by fully decoding a V2 sample.
func tryImageKey(sample, key []byte, xorKey int) bool {
	if len(sample) < 31 {
		return false
	}
	aesSize := int(binary.LittleEndian.Uint32(sample[6:]))
	xorSize := int(binary.LittleEndian.Uint32(sample[10:]))
	aligned := aesSize
	if rem := aligned % 16; rem != 0 {
		aligned += 16 - rem
	}
	if aligned <= 0 || aligned%16 != 0 || 15+aligned > len(sample) || xorSize < 0 || xorSize > len(sample) {
		return false
	}
	rawEnd := len(sample) - xorSize
	if rawEnd < 15+aligned {
		return false
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return false
	}
	encrypted := sample[15 : 15+aligned]
	aesPlain := make([]byte, len(encrypted))
	for off := 0; off < len(encrypted); off += 16 {
		blk.Decrypt(aesPlain[off:off+16], encrypted[off:off+16])
	}
	// The header records the exact plaintext length; the AES region is only
	// zero-padded to a block boundary, so take aes_size bytes as-is.
	if aesSize <= 0 || aesSize > len(aesPlain) {
		return false
	}
	raw := sample[15+aligned : rawEnd]
	xorPart := sample[rawEnd:]
	decoded := make([]byte, aesSize+len(raw)+len(xorPart))
	copy(decoded, aesPlain[:aesSize])
	copy(decoded[aesSize:], raw)
	for i, b := range xorPart {
		decoded[aesSize+len(raw)+i] = b ^ byte(xorKey)
	}
	return imageStructureValid(decoded)
}

func imageStructureValid(data []byte) bool {
	n := len(data)
	if n < 16 {
		return false
	}
	// JPEG
	if data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		if n >= 4 {
			switch data[3] {
			case 0xE0, 0xE1, 0xE2, 0xDB, 0xEE, 0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xED, 0xFE:
			default:
				return false
			}
		}
		return n >= 2 && data[n-2] == 0xFF && data[n-1] == 0xD9
	}
	// PNG
	if data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 {
		return bytes.HasSuffix(data, []byte{'I', 'E', 'N', 'D', 0xAE, 0x42, 0x60, 0x82})
	}
	// GIF
	if data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x38 {
		return data[n-1] == 0x3B
	}
	// WEBP
	if n >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		size := int(binary.LittleEndian.Uint32(data[4:8]))
		return size+8 <= n
	}
	// wxgf animation container
	if n >= 4 && string(data[0:4]) == "wxgf" {
		return true
	}
	return false
}

// scanImageKey finds the account-wide 16-byte ASCII AES key for V2 images.
func scanImageKey(pids []int, dbDir string) (string, int) {
	sample := findV2Sample(dbDir)
	if sample == nil {
		return "", 0
	}
	xorKey := 0x8F
	if n := len(sample); n >= 2 {
		for k := 0; k < 256; k++ {
			if sample[n-2]^byte(k) == 0xFF && sample[n-1]^byte(k) == 0xD9 {
				xorKey = k
				break
			}
		}
	}
	var foundKey []byte
	for _, pid := range pids {
		if foundKey != nil {
			break
		}
		handle, _, _ := procOpenProcess.Call(processVMRead|processQueryInfo, 0, uintptr(pid))
		if handle == 0 {
			continue
		}
		reader := regionReader{handle: handle}
		// Pass 1: every 16-byte-aligned window (covers binary key buffers).
		reader.forEachChunk(func(_ uint64, data []byte) {
			if foundKey != nil {
				return
			}
			for off := 0; off+16 <= len(data); off += 16 {
				key := data[off : off+16]
				if quickHeadCheck(sample, key) && tryImageKey(sample, key, xorKey) {
					foundKey = append([]byte(nil), key...)
					return
				}
			}
		})
		// Pass 2: printable ASCII windows at any offset.
		reader.forEachChunk(func(_ uint64, data []byte) {
			if foundKey != nil {
				return
			}
			for off := 0; off+16 <= len(data); off++ {
				printable := true
				for j := 0; j < 16; j++ {
					if data[off+j] < 0x20 || data[off+j] > 0x7e {
						printable = false
						break
					}
				}
				if !printable {
					continue
				}
				key := data[off : off+16]
				if quickHeadCheck(sample, key) && tryImageKey(sample, key, xorKey) {
					foundKey = append([]byte(nil), key...)
					return
				}
			}
		})
		procCloseHandle.Call(handle)
	}
	if foundKey == nil {
		return "", 0
	}
	return string(foundKey), xorKey
}

// findEmoticonSamples returns the first bytes of up to four distinct encrypted
// emoticon files, used to verify the account seed by decryption.
func findEmoticonSamples(dbDir string) [][]byte {
	root := filepath.Dir(dbDir)
	var out [][]byte
	seen := map[[8]byte]bool{}
	for _, sub := range []string{"Thumb", "Persist", "ThumbStore", "PersistStore"} {
		dir := filepath.Join(root, "business", "emoticon", sub)
		filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || len(out) >= 4 {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() < 64 {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil || len(data) < 64 {
				return nil
			}
			var prefix [8]byte
			copy(prefix[:], data[:8])
			if seen[prefix] {
				return nil
			}
			seen[prefix] = true
			out = append(out, data[:64])
			return nil
		})
	}
	return out
}

// emoticonKeyForSeed derives the WeChat 4.x emoticon AES-128 key:
// md5("<seed><wxid>EMOTICON") hex-decoded, first 16 bytes.
func emoticonKeyForSeed(seed, wxid string) []byte {
	sum := md5.Sum([]byte(seed + wxid + "EMOTICON"))
	return append([]byte(nil), sum[:16]...)
}

// emoticonHeadOK decrypts the first CBC block (IV = key) and checks an image magic.
func emoticonHeadOK(key, sample []byte) bool {
	if len(key) != 16 || len(sample) < 16 {
		return false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return false
	}
	var out [16]byte
	block.Decrypt(out[:], sample[:16])
	for i := range out {
		out[i] ^= key[i]
	}
	return imageHeadValid(out[:])
}

func accountWXIDs(dbDir string) []string {
	base := filepath.Base(filepath.Dir(dbDir))
	out := []string{base}
	if i := strings.LastIndex(base, "_"); i > 0 {
		suffix := base[i+1:]
		if len(suffix) == 4 && regexp.MustCompile(`^[0-9a-fA-F]{4}$`).MatchString(suffix) {
			out = append(out, base[:i])
		}
	}
	return out
}

// scanEmoticonSeed scans the main process for the decimal account seed and
// verifies derived emoticon keys against real encrypted emoticon files.
func scanEmoticonSeed(pids []int, dbDir string) (string, []byte, string, int) {
	samples := findEmoticonSamples(dbDir)
	if len(samples) == 0 {
		return "", nil, "", 0
	}
	wxids := accountWXIDs(dbDir)
	needHits := 2
	if len(samples) < needHits {
		needHits = len(samples)
	}
	tested := make(map[string]struct{}, 1<<16)
	var seed string
	var emoKey []byte
	for _, pid := range pids {
		if seed != "" {
			break
		}
		handle, _, _ := procOpenProcess.Call(processVMRead|processQueryInfo, 0, uintptr(pid))
		if handle == 0 {
			continue
		}
		reader := regionReader{handle: handle}
		reader.forEachChunk(func(_ uint64, data []byte) {
			if seed != "" {
				return
			}
			i := 0
			for i < len(data) {
				if data[i] < '0' || data[i] > '9' {
					i++
					continue
				}
				j := i
				for j < len(data) && data[j] >= '0' && data[j] <= '9' {
					j++
				}
				n := j - i
				if n >= 1 && n <= 20 && !(n > 1 && data[i] == '0') {
					cand := string(data[i:j])
					if _, ok := tested[cand]; !ok {
						tested[cand] = struct{}{}
						for _, wxid := range wxids {
							key := emoticonKeyForSeed(cand, wxid)
							hits := 0
							for _, sample := range samples {
								if emoticonHeadOK(key, sample) {
									hits++
								}
							}
							if hits >= needHits {
								seed = cand
								emoKey = key
								return
							}
						}
					}
				}
				i = j
			}
		})
		procCloseHandle.Call(handle)
	}
	if seed == "" {
		return "", nil, "", 0
	}
	// The same seed derives the chat-image AES key: md5("<seed><wxid>")[:16] as ASCII.
	for _, wxid := range wxids {
		sum := md5.Sum([]byte(seed + wxid))
		imgKey := hex.EncodeToString(sum[:])[:16]
		xorKey := 0x8F
		if n, ok := new(big.Int).SetString(seed, 10); ok {
			xorKey = int(new(big.Int).Mod(n, big.NewInt(256)).Int64())
		}
		if sample := findV2Sample(dbDir); sample != nil && tryImageKey(sample, []byte(imgKey), xorKey) {
			return seed, emoKey, imgKey, xorKey
		}
	}
	return seed, emoKey, "", 0
}
