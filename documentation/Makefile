# Makefile for LaTeX document compilation

# Main document name (without .tex extension)
MAIN = main

# Output directory
OUTPUT_DIR = compiled

# LaTeX compiler
LATEX = pdflatex

# LaTeX flags
LATEX_FLAGS = -interaction=nonstopmode -output-directory=$(OUTPUT_DIR)

compile:
	@mkdir -p $(OUTPUT_DIR)
	$(LATEX) $(LATEX_FLAGS) $(MAIN).tex
	$(LATEX) $(LATEX_FLAGS) $(MAIN).tex
