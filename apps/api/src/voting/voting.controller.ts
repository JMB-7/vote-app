import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { PARTICIPANT_ID } from '../auth/auth.service.js'
import { ModeratorGuard, ParticipantGuard } from '../auth/auth.guards.js'
import { VotingService } from './voting.service.js'
import {
  CreateAssemblyDto,
  CompleteAssemblyDto,
  CreateRoundDto,
  JoinAssemblyDto,
  LobbyPatchDto,
  ParticipantPatchDto,
  VoteDto,
} from './dtos.js'

type SessionRequest = Request & { [PARTICIPANT_ID]?: string }

function sessionId(request: SessionRequest): string {
  if (!request[PARTICIPANT_ID]) throw new Error('Participant guard did not attach the session identity')
  return request[PARTICIPANT_ID]
}

@Controller('assemblies')
export class PublicAssemblyController {
  constructor(private readonly voting: VotingService) {}

  @Post(':assemblyCode/join')
  join(@Param('assemblyCode') assemblyCode: string, @Body() input: JoinAssemblyDto) {
    return this.voting.joinAssembly(assemblyCode, input.firstName, input.lastName)
  }

  @Get(':assemblyCode/public-state')
  publicState(@Param('assemblyCode') assemblyCode: string) {
    return this.voting.publicState(assemblyCode)
  }
}

@Controller('participant')
@UseGuards(ParticipantGuard)
export class ParticipantController {
  constructor(private readonly voting: VotingService) {}

  @Get('me')
  me(@Req() request: SessionRequest) {
    return this.voting.participantState(sessionId(request))
  }

  @Post('rounds/:roundId/vote')
  vote(@Req() request: SessionRequest, @Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: VoteDto) {
    return this.voting.castVote(sessionId(request), roundId, input.optionId)
  }
}

@Controller('moderator')
@UseGuards(ModeratorGuard)
export class ModeratorController {
  constructor(private readonly voting: VotingService) {}

  @Get('session')
  session() {
    return { authenticated: true }
  }

  @Post('assemblies')
  createAssembly(@Body() input: CreateAssemblyDto) {
    return this.voting.createAssembly(input.name)
  }

  @Get('assemblies/:assemblyId')
  assembly(@Param('assemblyId', ParseUUIDPipe) assemblyId: string) {
    return this.voting.moderatorAssembly(assemblyId)
  }

  @Patch('assemblies/:assemblyId/lobby')
  lobby(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: LobbyPatchDto) {
    return this.voting.changeLobby(assemblyId, input.status)
  }

  @Post('assemblies/:assemblyId/complete')
  completeAssembly(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: CompleteAssemblyDto) {
    return this.voting.completeAssembly(assemblyId, input.confirmation)
  }

  @Patch('participants/:participantId')
  participant(@Param('participantId', ParseUUIDPipe) participantId: string, @Body() input: ParticipantPatchDto) {
    return this.voting.patchParticipant(participantId, input)
  }

  @Post('assemblies/:assemblyId/rounds')
  createRound(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: CreateRoundDto) {
    return this.voting.createRound(assemblyId, input)
  }

  @Post('rounds/:roundId/open')
  openRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.openRound(roundId)
  }

  @Post('rounds/:roundId/close')
  closeRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.closeRound(roundId)
  }

  @Post('rounds/:roundId/publish')
  publishRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.publishRound(roundId)
  }
}
