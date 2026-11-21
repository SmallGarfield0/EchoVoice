package config

import (
	"bytes"
	"fmt"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// UpgradeFile adds every key this binary understands but the file is missing.
//
// Configuration is loaded by layering defaults, then the file, then the
// environment. That keeps old files working but makes them lie: a server can be
// running with a 301-port relay range or a 1 MiB signalling limit while the
// file on disk shows neither. Anyone reviewing the deployment then reads a
// configuration that does not describe what is running, and a key that has to be
// explicit (rtc.turn.public_host) silently stays implicit.
//
// The patch is textual on purpose. Re-marshalling the whole document would drop
// every comment and reorder the file, which is a much bigger change than "add
// the keys that are missing". Only missing keys are inserted, at the end of the
// mapping they belong to, and the result is re-parsed before anything is written
// so a bad insertion can never corrupt a working configuration.
func UpgradeFile(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, fmt.Errorf("inspect config %q: %w", path, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, fmt.Errorf("read config %q: %w", path, err)
	}
	defaultsYAML, err := yaml.Marshal(Defaults())
	if err != nil {
		return false, fmt.Errorf("render config defaults: %w", err)
	}
	patched, changed, err := patchMissingKeys(data, defaultsYAML)
	if err != nil {
		return false, fmt.Errorf("upgrade config %q: %w", path, err)
	}
	if !changed {
		return false, nil
	}
	if err := yaml.Unmarshal(patched, &Config{}); err != nil {
		return false, fmt.Errorf("upgraded config %q does not parse: %w", path, err)
	}
	if err := writeFileAtomically(path, patched, info.Mode().Perm()); err != nil {
		return false, err
	}
	return true, nil
}

func writeFileAtomically(path string, data []byte, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o600
	}
	temp := path + ".upgrade"
	if err := os.WriteFile(temp, data, mode); err != nil {
		return fmt.Errorf("write upgraded config %q: %w", temp, err)
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("replace config %q: %w", path, err)
	}
	return nil
}

// insertion is one missing key that has to be appended to the end of parent's
// block in the original text.
type insertion struct {
	parent *yaml.Node
	key    string
	value  *yaml.Node
	path   string
}

func patchMissingKeys(data, defaultsYAML []byte) ([]byte, bool, error) {
	var fileDoc yaml.Node
	if err := yaml.Unmarshal(data, &fileDoc); err != nil {
		return nil, false, fmt.Errorf("parse existing document: %w", err)
	}
	var defaultsDoc yaml.Node
	if err := yaml.Unmarshal(defaultsYAML, &defaultsDoc); err != nil {
		return nil, false, fmt.Errorf("parse defaults document: %w", err)
	}
	root := documentMapping(&fileDoc)
	defaults := documentMapping(&defaultsDoc)
	if root == nil || defaults == nil {
		return data, false, nil
	}

	var inserts []insertion
	collectMissing(root, defaults, "", &inserts)
	if len(inserts) == 0 {
		return data, false, nil
	}

	lines := strings.Split(string(data), "\n")
	byParent := map[*yaml.Node][]insertion{}
	var order []*yaml.Node
	for _, item := range inserts {
		if _, seen := byParent[item.parent]; !seen {
			order = append(order, item.parent)
		}
		byParent[item.parent] = append(byParent[item.parent], item)
	}

	type patch struct {
		at    int
		lines []string
	}
	var patches []patch
	var rootBlock []string
	for _, parent := range order {
		indent := childIndent(parent)
		var block []string
		for _, item := range byParent[parent] {
			rendered := renderInsertion(item, indent)
			if len(rendered) == 0 {
				continue
			}
			if len(block) > 0 && parent == root {
				// Separate new top-level sections from each other; keys inside one
				// existing section stay grouped with their own comments.
				block = append(block, "")
			}
			block = append(block, rendered...)
		}
		if len(block) == 0 {
			continue
		}
		if parent == root {
			// New top-level sections all land at the end of the document, so they are
			// written as one block in the order this binary declares them.
			if len(rootBlock) > 0 {
				rootBlock = append(rootBlock, "")
			}
			rootBlock = append(rootBlock, block...)
			continue
		}
		patches = append(patches, patch{at: blockEnd(lines, parent, indent) + 1, lines: block})
	}
	if len(rootBlock) > 0 {
		// Appended first so that, at an equal insertion line, the nested blocks below
		// land above it and stay inside their own parent section.
		patches = append([]patch{{at: endOfDocument(lines), lines: rootBlock}}, patches...)
	}

	// Apply from the bottom of the file up so earlier insertions do not shift later
	// line numbers. Patches that share a line keep their discovery order: the root
	// mapping is visited before its children, and a later insertion at the same
	// index lands above the earlier one, which is what keeps a nested block inside
	// its own section when both end at the end of the file.
	sort.SliceStable(patches, func(i, j int) bool { return patches[i].at > patches[j].at })
	for _, item := range patches {
		if item.at < 0 || item.at > len(lines) {
			continue
		}
		block := append([]string{}, item.lines...)
		if item.at > 0 && strings.TrimSpace(lines[item.at-1]) != "" {
			block = append([]string{""}, block...)
		}
		tail := append([]string{}, lines[item.at:]...)
		lines = append(lines[:item.at], append(block, tail...)...)
	}
	return []byte(strings.Join(lines, "\n")), true, nil
}

func collectMissing(dst, src *yaml.Node, prefix string, out *[]insertion) {
	for index := 0; index+1 < len(src.Content); index += 2 {
		keyNode, valueNode := src.Content[index], src.Content[index+1]
		current := joinPath(prefix, keyNode.Value)
		existing := mappingValue(dst, keyNode.Value)
		if existing == nil {
			if defaultIsNoise(valueNode) {
				continue
			}
			*out = append(*out, insertion{parent: dst, key: keyNode.Value, value: valueNode, path: current})
			continue
		}
		if existing.Kind == yaml.MappingNode && valueNode.Kind == yaml.MappingNode {
			collectMissing(existing, valueNode, current, out)
		}
	}
}

// defaultIsNoise reports defaults that say nothing: an empty string means "unset"
// in this configuration, and writing `public_host: ""` would only suggest that an
// empty value is a normal, deliberate choice.
func defaultIsNoise(node *yaml.Node) bool {
	switch node.Kind {
	case yaml.ScalarNode:
		return node.Tag == "!!str" && strings.TrimSpace(node.Value) == ""
	case yaml.SequenceNode:
		return len(node.Content) == 0
	}
	return false
}

func renderInsertion(item insertion, indent int) []string {
	pad := strings.Repeat(" ", indent)
	out := []string{pad + "# added by ev-server: " + item.path}
	value := pruneNoise(item.value)
	if value.Kind == yaml.ScalarNode {
		return append(out, pad+item.key+": "+scalarText(value))
	}
	if value.Kind == yaml.MappingNode && len(value.Content) == 0 {
		return nil
	}
	rendered, ok := marshalNodeLines(value)
	if !ok {
		return nil
	}
	out = append(out, pad+item.key+":")
	inner := strings.Repeat(" ", indent+2)
	for _, line := range rendered {
		if line == "" {
			out = append(out, "")
			continue
		}
		out = append(out, inner+line)
	}
	return out
}

// pruneNoise drops the leaves that only restate "unset", so a whole inserted
// section does not carry lines like `public_host: ""`.
func pruneNoise(node *yaml.Node) *yaml.Node {
	if node.Kind != yaml.MappingNode {
		return node
	}
	clone := *node
	clone.Content = nil
	for index := 0; index+1 < len(node.Content); index += 2 {
		key, value := node.Content[index], node.Content[index+1]
		if defaultIsNoise(value) {
			continue
		}
		clone.Content = append(clone.Content, key, pruneNoise(value))
	}
	return &clone
}

func marshalNodeLines(node *yaml.Node) ([]string, bool) {
	var buffer bytes.Buffer
	encoder := yaml.NewEncoder(&buffer)
	encoder.SetIndent(2)
	if err := encoder.Encode(node); err != nil {
		_ = encoder.Close()
		return nil, false
	}
	if err := encoder.Close(); err != nil {
		return nil, false
	}
	text := strings.TrimRight(buffer.String(), "\n")
	if text == "" {
		return nil, false
	}
	return strings.Split(text, "\n"), true
}

func scalarText(node *yaml.Node) string {
	if node.Tag == "!!str" {
		return quoteIfNeeded(node.Value)
	}
	return node.Value
}

func quoteIfNeeded(value string) string {
	if value == "" {
		return `""`
	}
	needsQuotes := strings.ContainsAny(value, ":#{}[],&*?|-<>=!%@`\"'")
	needsQuotes = needsQuotes || strings.TrimSpace(value) != value
	if !needsQuotes {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

// childIndent is the indentation this mapping's keys use in the original text.
func childIndent(parent *yaml.Node) int {
	if len(parent.Content) >= 2 {
		return parent.Content[0].Column - 1
	}
	if parent.Column > 1 {
		return parent.Column + 1
	}
	return 0
}

// endOfDocument is the line index where new top-level sections start. Trailing
// blank lines are ignored, and a trailing comment block at column 0 stays at the
// end of the file where its author put it instead of being pushed above the new
// sections.
func endOfDocument(lines []string) int {
	end := len(lines)
	for end > 0 {
		line := lines[end-1]
		if strings.TrimSpace(line) == "" {
			end--
			continue
		}
		atColumnZero := len(line) == len(strings.TrimLeft(line, " "))
		if atColumnZero && strings.HasPrefix(strings.TrimSpace(line), "#") {
			end--
			continue
		}
		break
	}
	return end
}

// blockEnd is the zero-based line index of the last line that belongs to parent's
// block. Scanning stops at the first line that is indented at or below the block,
// which is where the next key or section starts.
func blockEnd(lines []string, parent *yaml.Node, indent int) int {
	start := parent.Line - 1
	if start < 0 {
		start = 0
	}
	if start >= len(lines) {
		return len(lines) - 1
	}
	last := start
	for index := start + 1; index < len(lines); index++ {
		trimmed := strings.TrimSpace(lines[index])
		if trimmed == "" {
			continue
		}
		current := len(lines[index]) - len(strings.TrimLeft(lines[index], " \t"))
		if current < indent {
			break
		}
		last = index
	}
	return last
}

func documentMapping(doc *yaml.Node) *yaml.Node {
	if doc == nil {
		return nil
	}
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return nil
		}
		doc = doc.Content[0]
	}
	if doc.Kind != yaml.MappingNode {
		return nil
	}
	return doc
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return node.Content[index+1]
		}
	}
	return nil
}

func joinPath(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}
