//go:build !windows

package main

import (
	"fmt"
	"os/exec"
)

func hideConsole(c *exec.Cmd) {}
func openDefault(url string)  { exec.Command("xdg-open", url).Start() }
func fail(msg string)         { fmt.Println(msg) }
