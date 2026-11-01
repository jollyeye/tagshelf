//go:build windows

package main

import (
	"log"
	"runtime"
	"syscall"
	"unsafe"
)

// A small notification-area (system tray) icon: click = open the window, right-click = menu with Quit.
// Built on plain Win32 calls (no third-party packages).

var (
	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	procGetModuleHandle  = kernel32.NewProc("GetModuleHandleW")
	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procGetMessage       = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessage  = user32.NewProc("DispatchMessageW")
	procPostMessage      = user32.NewProc("PostMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procRegisterWinMsg   = user32.NewProc("RegisterWindowMessageW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenu       = user32.NewProc("AppendMenuW")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procDestroyMenu      = user32.NewProc("DestroyMenu")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procSetForeground    = user32.NewProc("SetForegroundWindow")
	procCreateIconInd    = user32.NewProc("CreateIconIndirect")
	procCreateBitmap     = gdi32.NewProc("CreateBitmap")
	procShellNotifyIcon  = syscall.NewLazyDLL("shell32.dll").NewProc("Shell_NotifyIconW")
)

const (
	wmNull     = 0x0000
	wmDestroy  = 0x0002
	wmClose    = 0x0010
	wmUser     = 0x0400
	wmTray     = wmUser + 1
	wmLBtnUp   = 0x0202
	wmRBtnUp   = 0x0205
	nimAdd     = 0
	nimDelete  = 2
	nifMessage = 0x1
	nifIcon    = 0x2
	nifTip     = 0x4
	mfString   = 0x0
	mfSep      = 0x800
	tpmRight   = 0x2
	tpmReturn  = 0x100
	idOpen     = 1
	idQuit     = 2
)

type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UTimeout         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         [16]byte
	HBalloonIcon     uintptr
}

type wndClassEx struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      [2]int32
	_       uint32
}

type iconInfo struct {
	FIcon    uint32
	XHotspot uint32
	YHotspot uint32
	HbmMask  uintptr
	HbmColor uintptr
}

// trayIconHandle draws the icon (a blue rounded square with a white tag) in memory.
func trayIconHandle() uintptr {
	const n = 32
	px := make([]byte, n*n*4) // BGRA
	set := func(x, y int, b, g, r, a byte) { i := (y*n + x) * 4; px[i], px[i+1], px[i+2], px[i+3] = b, g, r, a }
	inRound := func(x, y int) bool {
		const rad = 7
		cx, cy := x, y
		if cx < rad {
			cx = rad
		} else if cx > n-1-rad {
			cx = n - 1 - rad
		}
		if cy < rad {
			cy = rad
		} else if cy > n-1-rad {
			cy = n - 1 - rad
		}
		dx, dy := x-cx, y-cy
		return dx*dx+dy*dy <= rad*rad
	}
	inTag := func(x, y int) bool {
		if x >= 7 && x <= 19 && y >= 10 && y <= 22 {
			return true
		}
		if x > 19 && x <= 26 {
			d := y - 16
			if d < 0 {
				d = -d
			}
			return d <= 6-(x-19)
		}
		return false
	}
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			switch {
			case !inRound(x, y):
			case inTag(x, y) && (x-11)*(x-11)+(y-16)*(y-16) > 5:
				set(x, y, 255, 255, 255, 255)
			default:
				set(x, y, 0xff, 0x8c, 0x4f, 255)
			}
		}
	}
	color, _, _ := procCreateBitmap.Call(n, n, 1, 32, uintptr(unsafe.Pointer(&px[0])))
	mask := make([]byte, n*n/8)
	hm, _, _ := procCreateBitmap.Call(n, n, 1, 1, uintptr(unsafe.Pointer(&mask[0])))
	ii := iconInfo{FIcon: 1, HbmMask: hm, HbmColor: color}
	ic, _, _ := procCreateIconInd.Call(uintptr(unsafe.Pointer(&ii)))
	return ic
}

func startTray(s *Server, url string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hinst, _, _ := procGetModuleHandle.Call(0)
	className, _ := syscall.UTF16PtrFromString("TagShelfTray")
	icon := trayIconHandle()
	taskbarCreated, _, _ := procRegisterWinMsg.Call(uintptr(unsafe.Pointer(mustUTF16("TaskbarCreated"))))

	var hwnd uintptr
	add := func() {
		nid := notifyIconData{HWnd: hwnd, UID: 1, UFlags: nifMessage | nifIcon | nifTip, UCallbackMessage: wmTray, HIcon: icon}
		nid.CbSize = uint32(unsafe.Sizeof(nid))
		copy(nid.SzTip[:], syscall.StringToUTF16("TagShelf - click to open, right-click for the menu"))
		procShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	}
	remove := func() {
		nid := notifyIconData{HWnd: hwnd, UID: 1}
		nid.CbSize = uint32(unsafe.Sizeof(nid))
		procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	}
	menu := func() {
		m, _, _ := procCreatePopupMenu.Call()
		procAppendMenu.Call(m, mfString, idOpen, uintptr(unsafe.Pointer(mustUTF16("Open TagShelf"))))
		procAppendMenu.Call(m, mfSep, 0, 0)
		procAppendMenu.Call(m, mfString, idQuit, uintptr(unsafe.Pointer(mustUTF16("Quit TagShelf"))))
		var pt [2]int32
		procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
		procSetForeground.Call(hwnd) // required, or the menu does not close when you click elsewhere
		cmd, _, _ := procTrackPopupMenu.Call(m, tpmRight|tpmReturn, uintptr(pt[0]), uintptr(pt[1]), 0, hwnd, 0)
		procPostMessage.Call(hwnd, wmNull, 0, 0)
		procDestroyMenu.Call(m)
		switch cmd {
		case idOpen:
			go openWindow(s.dataDir, url)
		case idQuit:
			s.Quit()
		}
	}

	proc := syscall.NewCallback(func(h, msg, wp, lp uintptr) uintptr {
		switch {
		case msg == wmTray:
			switch lp & 0xffff {
			case wmLBtnUp:
				go openWindow(s.dataDir, url)
			case wmRBtnUp:
				menu()
			}
			return 0
		case msg == uintptr(taskbarCreated) && taskbarCreated != 0:
			add() // Explorer restarted: put the icon back
			return 0
		case msg == wmClose:
			procDestroyWindow.Call(h)
			return 0
		case msg == wmDestroy:
			remove()
			procPostQuitMessage.Call(0)
			return 0
		}
		r, _, _ := procDefWindowProc.Call(h, msg, wp, lp)
		return r
	})

	wc := wndClassEx{LpfnWndProc: proc, HInstance: hinst, LpszClassName: className}
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	if a, _, _ := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		log.Printf("tray icon: cannot register window class")
		return
	}
	hwnd, _, _ = procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(mustUTF16("TagShelf"))), 0, 0, 0, 0, 0, 0, 0, hinst, 0)
	if hwnd == 0 {
		log.Printf("tray icon: cannot create window")
		return
	}
	add()
	go func() {
		<-s.quit
		procPostMessage.Call(hwnd, wmClose, 0, 0)
	}()
	var m winMsg
	for {
		r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func mustUTF16(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}
