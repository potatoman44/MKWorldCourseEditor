//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

func hideConsole(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func openDefault(url string) {
	c := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	hideConsole(c)
	c.Start()
}

func fail(msg string) {
	u := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(msg)
	c, _ := syscall.UTF16PtrFromString("MK World Course Editor")
	u.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
}
