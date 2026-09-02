# Automation registry (orbit) - what you can call

Every callable here can be invoked from any other automation (CallWorkflow
node). Rebuilt by `scripts/ua.mjs registry --tag icm` on 2026-09-02.

| name | id | tags | trigger | inputs | outputs |
| --- | --- | --- | --- | --- | --- |
| ICM | Check Period Writable | 6a984db32ada0c631024ad52 | icm | CALLABLE | periodId:string | status:string, writable:boolean, periodName:string, periodStatus:string, reason:string |
| ICM | Resolve Seat Occupant | 6a9879742ada0c631031e64b | icm | CALLABLE | positionId:string, asOfDate:string | status:string, success:boolean, message:string, asOfDate:string, asOfEpoch:integer, positionId:string, positionCode:string, positionName:string, payeeId:string, employeeId:string, payeeName:string, payeeCurrency:string, payeeCurrencySymbol:string, effectiveStart:string, effectiveEnd:string, allocationPct:number, matchCount:integer |

## Descriptions

- **ICM | Check Period Writable**: Given a periodId, says whether that period currently accepts writes. The shared guard every automation that writes with a periodId calls first.
- **ICM | Resolve Seat Occupant**: Given a Position and a date, says who held that seat on that date - or names exactly why the question has no single answer. Spec: docs/automations/resolve-seat-occupant.md. NOT for the calculation path; the engine does this fold in memory.
