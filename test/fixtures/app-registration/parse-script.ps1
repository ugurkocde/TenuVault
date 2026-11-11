param([string]$Script)
$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }
$bad = $ast.FindAll({
    param($node)
    $node.GetType().Name -in @('TernaryExpressionAst', 'PipelineChainAst') -or
    ($node.GetType().Name -eq 'BinaryExpressionAst' -and $node.Operator -eq 'QuestionQuestion') -or
    ($node.GetType().Name -eq 'AssignmentStatementAst' -and $node.Operator -eq 'QuestionQuestionEquals')
}, $true)
if ($bad.Count) { exit 2 }
