//go:build !windows

package main

func listDrives() []Drive { return []Drive{{Name: "File system", Path: "/", Kind: "fixed"}} }
