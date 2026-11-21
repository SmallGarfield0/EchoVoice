//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var getConsoleProcessList = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleProcessList")

func pauseAfterStartupError() {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("EV_PAUSE_ON_ERROR")))
	if mode == "0" || mode == "false" || mode == "never" {
		return
	}
	if mode != "1" && mode != "true" && mode != "always" && !ownsIndependentConsole() {
		return
	}
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Press Enter to close this window...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func ownsIndependentConsole() bool {
	processIDs := make([]uint32, 4)
	count, _, _ := getConsoleProcessList.Call(
		uintptr(unsafe.Pointer(&processIDs[0])),
		uintptr(len(processIDs)),
	)
	return count == 1
}
